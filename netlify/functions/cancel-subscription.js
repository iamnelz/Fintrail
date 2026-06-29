// Fintrail Subscription Management - authenticated Stripe Customer Portal
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

async function getAuthenticatedUser(event, supabase) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const user = await getAuthenticatedUser(event, supabase);
    if (!user?.id || !user.email) {
      return json(401, { error: 'Authentication required' });
    }

    const { data: billingRow, error: billingReadError } = await supabase
      .from('user_data')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (billingReadError) throw billingReadError;

    const customers = await stripe.customers.list({
      email: user.email.trim().toLowerCase(),
      limit: 100
    });
    let customer = customers.data.find(item => item.id === billingRow?.stripe_customer_id);

    // Prefer the historical duplicate customer that actually owns the
    // subscription so the portal always opens the correct billing record.
    for (const candidate of customers.data) {
      const subscriptions = await stripe.subscriptions.list({
        customer: candidate.id,
        status: 'all',
        limit: 100
      });
      if (subscriptions.data.some(item => ACTIVE_SUBSCRIPTION_STATUSES.has(item.status))) {
        customer = candidate;
        break;
      }
    }

    if (!customer) return json(404, { error: 'No customer found' });

    const { error: customerSaveError } = await supabase.from('user_data').upsert({
      user_id: user.id,
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (customerSaveError) throw customerSaveError;

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: 'https://fintrail.app'
    });

    return json(200, { url: session.url });
  } catch (err) {
    console.log('Portal error:', err.message);
    return json(500, { error: 'Unable to open subscription management' });
  }
};
