// Fintrail Stripe Customer Diagnostic - read-only billing incident report
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function authorized(event) {
  const header =
    event.headers['x-fintrail-billing-diagnostic-secret'] ||
    event.headers['X-Fintrail-Billing-Diagnostic-Secret'] ||
    '';
  return !!process.env.FINTRAIL_BILLING_DIAGNOSTIC_SECRET &&
    header === process.env.FINTRAIL_BILLING_DIAGNOSTIC_SECRET;
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

function summarizeSubscription(subscription) {
  return {
    id: subscription.id,
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    metadata: subscription.metadata || {},
    item_price_ids: (subscription.items?.data || []).map(item => item.price?.id).filter(Boolean)
  };
}

function summarizeInvoice(invoice) {
  return {
    id: invoice.id,
    status: invoice.status,
    subscription: invoice.subscription || null,
    total: invoice.total,
    amount_paid: invoice.amount_paid,
    currency: invoice.currency,
    created: invoice.created ? new Date(invoice.created * 1000).toISOString() : null,
    hosted_invoice_url: invoice.hosted_invoice_url || null
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!authorized(event)) {
    return json(401, { error: 'Unauthorized' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const email = normalizeEmail(body.email);
  const userId = String(body.user_id || '').trim();
  if (!email && !userId) {
    return json(400, { error: 'Provide email or user_id' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  try {
    let profile = null;
    if (userId) {
      const { data, error } = await supabase
        .from('user_data')
        .select('user_id,stripe_customer_id,stripe_subscription_id,subscription_status,current_period_end,is_pro')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      profile = data || null;
    }

    const diagnosticEmail = email;
    const customers = diagnosticEmail ? await listCustomersByEmail(diagnosticEmail) : [];
    const customerReports = [];

    for (const customer of customers) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'all',
        limit: 100
      });
      const invoices = await stripe.invoices.list({
        customer: customer.id,
        limit: 20
      });
      customerReports.push({
        id: customer.id,
        email: customer.email,
        created: customer.created ? new Date(customer.created * 1000).toISOString() : null,
        metadata: customer.metadata || {},
        is_current_supabase_mapping: profile?.stripe_customer_id === customer.id,
        subscriptions: subscriptions.data.map(summarizeSubscription),
        invoices: invoices.data.map(summarizeInvoice)
      });
    }

    const activeLikeStatuses = new Set(['incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused']);
    const activeLikeSubscriptions = customerReports.flatMap(customer =>
      customer.subscriptions
        .filter(subscription =>
          activeLikeStatuses.has(subscription.status) ||
          subscription.cancel_at_period_end === true
        )
        .map(subscription => ({
          customer_id: customer.id,
          subscription_id: subscription.id,
          status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_end: subscription.current_period_end
        }))
    );

    return json(200, {
      ok: true,
      read_only: true,
      email: diagnosticEmail || null,
      user_id: userId || null,
      current_supabase_mapping: profile,
      customer_count: customerReports.length,
      active_like_subscription_count: activeLikeSubscriptions.length,
      active_like_subscriptions: activeLikeSubscriptions,
      customers: customerReports,
      note: 'Diagnostic only. No customers, subscriptions, invoices, refunds, or Supabase rows were modified.'
    });
  } catch (error) {
    console.log('Stripe customer diagnostic error:', error.message);
    return json(500, { error: 'Unable to generate diagnostic report' });
  }
};
