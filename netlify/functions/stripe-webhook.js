// Fintrail Stripe Webhook Function
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);

function periodEnd(subscription) {
  return subscription?.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
}

async function resolveUserId(object, customer, supabase) {
  const metadataUserId =
    object?.metadata?.fintrail_user_id ||
    object?.client_reference_id ||
    customer?.metadata?.fintrail_user_id;
  if (metadataUserId) return metadataUserId;

  const email = object?.customer_email || customer?.email;
  if (!email) return null;

  // Legacy subscriptions predate Fintrail user metadata. Resolve those once,
  // then future events use the stored Stripe customer relationship.
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000
    });
    if (error) throw error;
    const user = data.users.find(item =>
      String(item.email || '').toLowerCase() === String(email).toLowerCase()
    );
    if (user) return user.id;
    if (data.users.length < 1000) break;
    page += 1;
  }
  return null;
}

async function saveBillingState(supabase, userId, values) {
  if (!userId) throw new Error('No Fintrail user found for Stripe event');
  const { error } = await supabase.from('user_data').upsert({
    user_id: userId,
    ...values,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

exports.handler = async function(event) {
  const signature = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const customer = await stripe.customers.retrieve(session.customer);
        const subscription = session.subscription
          ? await stripe.subscriptions.retrieve(session.subscription)
          : null;
        const userId = await resolveUserId(session, customer, supabase);
        await saveBillingState(supabase, userId, {
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription?.id || session.subscription || null,
          subscription_status: subscription?.status || 'active',
          current_period_end: periodEnd(subscription),
          is_pro: subscription ? PRO_STATUSES.has(subscription.status) : true
        });
        break;
      }

      case 'invoice.paid': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const customer = await stripe.customers.retrieve(invoice.customer);
        const userId = await resolveUserId(subscription, customer, supabase);
        await saveBillingState(supabase, userId, {
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id,
          subscription_status: subscription.status,
          current_period_end: periodEnd(subscription),
          is_pro: PRO_STATUSES.has(subscription.status)
        });
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        const userId = await resolveUserId(subscription, customer, supabase);
        const deleted = stripeEvent.type === 'customer.subscription.deleted';
        await saveBillingState(supabase, userId, {
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id,
          subscription_status: deleted ? 'canceled' : subscription.status,
          current_period_end: periodEnd(subscription),
          is_pro: !deleted && PRO_STATUSES.has(subscription.status)
        });
        break;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.log('Webhook handler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
