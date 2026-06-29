// Fintrail Stripe Checkout Function - duplicate customer/subscription protected
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

async function listCustomersByEmail(email) {
  const customers = [];
  let startingAfter;

  do {
    const page = await stripe.customers.list({
      email,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    customers.push(...page.data.filter(customer => !customer.deleted));
    startingAfter = page.has_more ? page.data[page.data.length - 1]?.id : null;
  } while (startingAfter);

  return customers;
}

async function findProtectedSubscription(customers) {
  for (const customer of customers) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 100
    });
    const subscription = subscriptions.data.find(item =>
      ACTIVE_SUBSCRIPTION_STATUSES.has(item.status)
    );
    if (subscription) return { customer, subscription };
  }
  return null;
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

    const email = user.email.trim().toLowerCase();
    const { data: billingRow, error: billingReadError } = await supabase
      .from('user_data')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (billingReadError) throw billingReadError;

    const customers = await listCustomersByEmail(email);
    let customer = customers.find(item => item.id === billingRow?.stripe_customer_id);

    // Check every matching customer because historical duplicate customers may
    // each hold a subscription.
    const protectedSubscription = await findProtectedSubscription(customers);
    if (protectedSubscription) {
      customer = protectedSubscription.customer;
      await supabase.from('user_data').upsert({
        user_id: user.id,
        stripe_customer_id: customer.id,
        stripe_subscription_id: protectedSubscription.subscription.id,
        subscription_status: protectedSubscription.subscription.status,
        current_period_end: protectedSubscription.subscription.current_period_end
          ? new Date(protectedSubscription.subscription.current_period_end * 1000).toISOString()
          : null,
        is_pro: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

      const portal = await stripe.billingPortal.sessions.create({
        customer: customer.id,
        return_url: 'https://fintrail.app'
      });
      return json(200, {
        url: portal.url,
        alreadySubscribed: true,
        destination: 'billing_portal'
      });
    }

    if (!customer) customer = customers[0];
    if (!customer) {
      customer = await stripe.customers.create({
        email,
        metadata: { fintrail_user_id: user.id }
      }, {
        idempotencyKey: `fintrail_customer_${user.id}`
      });
    } else if (customer.metadata?.fintrail_user_id !== user.id) {
      customer = await stripe.customers.update(customer.id, {
        metadata: {
          ...customer.metadata,
          fintrail_user_id: user.id
        }
      });
    }

    const { error: customerSaveError } = await supabase.from('user_data').upsert({
      user_id: user.id,
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (customerSaveError) throw customerSaveError;

    // A deterministic ten-minute key makes network retries return the same
    // Checkout Session instead of creating parallel subscriptions.
    const windowKey = Math.floor(Date.now() / 600000);
    const idempotencyKey = `fintrail_checkout_${user.id}_${windowKey}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer: customer.id,
      client_reference_id: user.id,
      metadata: { fintrail_user_id: user.id },
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { fintrail_user_id: user.id }
      },
      success_url: 'https://fintrail.app?upgraded=true',
      cancel_url: 'https://fintrail.app?cancelled=true'
    }, { idempotencyKey });

    return json(200, { url: session.url, destination: 'checkout' });
  } catch (err) {
    console.log('Stripe checkout error:', err.message);
    return json(500, { error: 'Unable to start checkout' });
  }
};
