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

async function beginWebhookEvent(supabase, stripeEvent) {
  const { error: insertError } = await supabase
    .from('stripe_webhook_events')
    .insert({
      stripe_event_id: stripeEvent.id,
      event_type: stripeEvent.type,
      processing_status: 'processing',
      payload: {
        object_id: stripeEvent.data?.object?.id || null,
        object_type: stripeEvent.data?.object?.object || null
      }
    });
  if (!insertError) return { duplicate: false };
  if (insertError.code !== '23505') throw insertError;

  const { data: existing, error: readError } = await supabase
    .from('stripe_webhook_events')
    .select('processing_status,attempt_count')
    .eq('stripe_event_id', stripeEvent.id)
    .maybeSingle();
  if (readError) throw readError;
  if (existing?.processing_status === 'processed') return { duplicate: true };

  const { error: retryError } = await supabase
    .from('stripe_webhook_events')
    .update({
      processing_status: 'processing',
      error_message: null,
      attempt_count: Number(existing?.attempt_count || 1) + 1,
      updated_at: new Date().toISOString()
    })
    .eq('stripe_event_id', stripeEvent.id);
  if (retryError) throw retryError;
  return { duplicate: false };
}

async function finishWebhookEvent(supabase, stripeEventId, error) {
  const { error: updateError } = await supabase
    .from('stripe_webhook_events')
    .update({
      processing_status: error ? 'failed' : 'processed',
      error_message: error ? String(error.message || error).slice(0, 1000) : null,
      processed_at: error ? null : new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('stripe_event_id', stripeEventId);
  if (updateError) {
    console.log('Webhook event status error:', updateError.message);
  }
}

function rewardGrantIdFrom(object, subscription) {
  return object?.metadata?.fintrail_reward_grant_id ||
    subscription?.metadata?.fintrail_reward_grant_id ||
    null;
}

async function releaseRewardLock(supabase, userId, rewardGrantId) {
  if (!userId || !rewardGrantId) return;
  const { error } = await supabase.rpc('release_fintrail_reward_billing_lock', {
    p_user_id: userId,
    p_reward_grant_id: rewardGrantId
  });
  if (error) console.log('Reward lock release error:', error.message);
}

async function activateRewardGrant(
  supabase,
  rewardGrantId,
  userId,
  stripeEvent,
  customerId,
  subscriptionId,
  checkoutSessionId,
  invoiceId
) {
  if (!rewardGrantId || !userId) return;

  const { data: grant, error: grantReadError } = await supabase
    .from('reward_grants')
    .select('id,user_id,status')
    .eq('id', rewardGrantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (grantReadError) throw grantReadError;
  if (!grant) throw new Error('Stripe reward grant does not belong to user');

  if (['claimed', 'scheduled', 'failed'].includes(grant.status)) {
    const { error: updateError } = await supabase
      .from('reward_grants')
      .update({
        status: 'active',
        applied_at: new Date().toISOString(),
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null,
        stripe_checkout_session_id: checkoutSessionId || null,
        stripe_invoice_id: invoiceId || null,
        stripe_event_id: stripeEvent.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', rewardGrantId)
      .eq('user_id', userId);
    if (updateError) throw updateError;
  }

  await releaseRewardLock(supabase, userId, rewardGrantId);
  console.log('FINTRAIL REWARD CONFIRMED', JSON.stringify({
    reward_grant_id: rewardGrantId,
    user_id: userId,
    stripe_event_id: stripeEvent.id
  }));
}

async function failExpiredRewardCheckout(supabase, session, stripeEvent) {
  const rewardGrantId = rewardGrantIdFrom(session);
  const userId = session.metadata?.fintrail_user_id || session.client_reference_id;
  if (!rewardGrantId || !userId) return;

  const { data: grant, error: readError } = await supabase
    .from('reward_grants')
    .select('id,status,notes')
    .eq('id', rewardGrantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw readError;
  if (grant?.status === 'claimed') {
    const { error: updateError } = await supabase
      .from('reward_grants')
      .update({
        status: 'failed',
        notes: {
          ...(grant.notes || {}),
          failed_reason: 'checkout_session_expired'
        },
        stripe_event_id: stripeEvent.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', rewardGrantId);
    if (updateError) throw updateError;
  }
  await releaseRewardLock(supabase, userId, rewardGrantId);
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

  let webhookStarted = false;
  try {
    const webhookState = await beginWebhookEvent(supabase, stripeEvent);
    if (webhookState.duplicate) {
      return {
        statusCode: 200,
        body: JSON.stringify({ received: true, duplicate: true })
      };
    }
    webhookStarted = true;

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
        await activateRewardGrant(
          supabase,
          rewardGrantIdFrom(session, subscription),
          userId,
          stripeEvent,
          customer.id,
          subscription?.id || session.subscription || null,
          session.id,
          null
        );
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
        await activateRewardGrant(
          supabase,
          rewardGrantIdFrom(invoice, subscription),
          userId,
          stripeEvent,
          customer.id,
          subscription.id,
          null,
          invoice.id
        );
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
        if (!deleted) {
          await activateRewardGrant(
            supabase,
            rewardGrantIdFrom(subscription),
            userId,
            stripeEvent,
            customer.id,
            subscription.id,
            null,
            null
          );
        }
        break;
      }

      case 'checkout.session.expired': {
        await failExpiredRewardCheckout(
          supabase,
          stripeEvent.data.object,
          stripeEvent
        );
        break;
      }
    }

    await finishWebhookEvent(supabase, stripeEvent.id, null);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.log('Webhook handler error:', err.message);
    if (webhookStarted) {
      await finishWebhookEvent(supabase, stripeEvent.id, err);
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
