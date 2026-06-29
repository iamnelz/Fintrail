// Fintrail Reward Claim Engine - Phase 2C
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const EXISTING_SUBSCRIPTION_STATUSES = new Set([
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused'
]);
const CLAIMABLE_TIERS = new Set(['silver', 'gold', 'platinum', 'diamond']);

const REWARD_CONFIG = {
  silver_free_month: {
    kind: 'coupon',
    env: 'STRIPE_REWARD_SILVER_COUPON_ID',
    percentOff: 100,
    duration: 'once'
  },
  gold_two_free_months: {
    kind: 'coupon',
    env: 'STRIPE_REWARD_GOLD_COUPON_ID',
    percentOff: 100,
    duration: 'repeating',
    durationInMonths: 2
  },
  platinum_10_percent_12_months: {
    kind: 'coupon',
    env: 'STRIPE_REWARD_PLATINUM_COUPON_ID',
    percentOff: 10,
    duration: 'repeating',
    durationInMonths: 12
  },
  diamond_founding_349: {
    kind: 'price',
    env: 'STRIPE_DIAMOND_FOUNDING_PRICE_ID',
    unitAmount: 349
  },
  diamond_standard_599: {
    kind: 'price',
    env: 'STRIPE_DIAMOND_STANDARD_PRICE_ID',
    unitAmount: 599
  }
};

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

function isExistingSubscription(subscription) {
  return !!subscription && (
    EXISTING_SUBSCRIPTION_STATUSES.has(subscription.status) ||
    (
      subscription.cancel_at_period_end === true &&
      subscription.status !== 'canceled' &&
      subscription.status !== 'incomplete_expired'
    )
  );
}

async function findExistingSubscription(customers, preferredSubscriptionId) {
  if (preferredSubscriptionId) {
    try {
      const preferred = await stripe.subscriptions.retrieve(
        preferredSubscriptionId,
        { expand: ['discounts'] }
      );
      if (isExistingSubscription(preferred)) return preferred;
    } catch (error) {
      if (error?.code !== 'resource_missing') throw error;
    }
  }

  for (const customer of customers) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 100,
      expand: ['data.discounts']
    });
    const existingSubscription = subscriptions.data.find(subscription =>
      isExistingSubscription(subscription)
    );
    if (existingSubscription) return existingSubscription;
  }
  return null;
}

function getExpandedDiscounts(subscription) {
  const values = Array.isArray(subscription?.discounts)
    ? subscription.discounts
    : subscription?.discount ? [subscription.discount] : [];
  return values.filter(value => value && typeof value === 'object' && !value.deleted);
}

function getActiveDiscountEnd(subscription) {
  const now = Math.floor(Date.now() / 1000);
  const active = getExpandedDiscounts(subscription).filter(discount =>
    !discount.end || discount.end > now
  );
  if (!active.length) return null;
  const finiteEnds = active.map(discount => discount.end).filter(Boolean);
  return finiteEnds.length ? Math.max(...finiteEnds) : subscription.current_period_end;
}

async function validateRewardResource(variant) {
  const config = REWARD_CONFIG[variant];
  if (!config) throw new Error('Unsupported reward variant');
  const resourceId = process.env[config.env];
  if (!resourceId) throw new Error(`${config.env} is not configured`);

  if (config.kind === 'coupon') {
    const coupon = await stripe.coupons.retrieve(resourceId);
    if (
      coupon.deleted ||
      coupon.valid === false ||
      Number(coupon.percent_off) !== config.percentOff ||
      coupon.duration !== config.duration ||
      (
        config.durationInMonths &&
        Number(coupon.duration_in_months) !== config.durationInMonths
      )
    ) {
      throw new Error(`Stripe coupon configuration is invalid for ${variant}`);
    }
  } else {
    const price = await stripe.prices.retrieve(resourceId);
    if (
      !price.active ||
      !price.recurring ||
      price.recurring.interval !== 'month' ||
      Number(price.unit_amount) !== config.unitAmount
    ) {
      throw new Error(`Stripe price configuration is invalid for ${variant}`);
    }
  }

  return { ...config, resourceId };
}

async function updateGrant(supabase, grantId, values) {
  const { error } = await supabase
    .from('reward_grants')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('id', grantId);
  if (error) throw error;
}

async function releaseLock(supabase, userId, grantId) {
  const { error } = await supabase.rpc('release_fintrail_reward_billing_lock', {
    p_user_id: userId,
    p_reward_grant_id: grantId
  });
  if (error) console.log('Reward billing lock release error:', error.message);
}

async function scheduleGrant(supabase, grant, reason, activationNotBefore) {
  const values = {
    status: 'scheduled',
    scheduled_at: grant.scheduled_at || new Date().toISOString(),
    activation_not_before: activationNotBefore || null,
    notes: {
      ...(grant.notes || {}),
      scheduled_reason: reason,
      scheduled_by: 'claim-reward'
    }
  };
  await updateGrant(supabase, grant.id, values);
  return {
    status: 'scheduled',
    reason,
    activation_not_before: values.activation_not_before
  };
}

async function findOpenCheckout(customers) {
  for (const customer of customers) {
    const sessions = await stripe.checkout.sessions.list({
      customer: customer.id,
      status: 'open',
      limit: 10
    });
    const subscriptionSession = sessions.data.find(session =>
      session.mode === 'subscription'
    );
    if (subscriptionSession) return subscriptionSession;
  }
  return null;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  let user;
  let grant;
  let lockAcquired = false;

  try {
    user = await getAuthenticatedUser(event, supabase);
    if (!user?.id || !user.email) {
      return json(401, { error: 'Authentication required' });
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (error) {
      return json(400, { error: 'Invalid JSON body' });
    }

    const allowedKeys = new Set(['reward_grant_id', 'tier']);
    if (Object.keys(body).some(key => !allowedKeys.has(key))) {
      return json(400, { error: 'Only reward_grant_id or tier may be submitted' });
    }
    if (!!body.reward_grant_id === !!body.tier) {
      return json(400, { error: 'Provide exactly one reward_grant_id or tier' });
    }
    if (body.tier && !CLAIMABLE_TIERS.has(String(body.tier).toLowerCase())) {
      return json(400, { error: 'Invalid reward tier' });
    }

    let grantQuery = supabase
      .from('reward_grants')
      .select('*')
      .eq('user_id', user.id);
    grantQuery = body.reward_grant_id
      ? grantQuery.eq('id', body.reward_grant_id)
      : grantQuery.eq('tier', String(body.tier).toLowerCase());
    const { data: loadedGrant, error: grantError } = await grantQuery.maybeSingle();
    if (grantError) throw grantError;
    if (!loadedGrant) return json(404, { error: 'Reward grant not found' });
    grant = loadedGrant;

    const deterministicKey = `fintrail_reward_claim_${grant.id}`;
    const { data: reservedRows, error: reserveError } = await supabase.rpc(
      'reserve_fintrail_reward_claim',
      {
        p_user_id: user.id,
        p_reward_grant_id: grant.id,
        p_idempotency_key: deterministicKey
      }
    );
    if (reserveError) return json(409, { error: reserveError.message });
    const reserved = reservedRows?.[0];
    if (!reserved) throw new Error('Reward reservation returned no grant');

    if (['active', 'completed'].includes(reserved.grant_status)) {
      return json(200, {
        ok: true,
        idempotent: true,
        reward_grant_id: reserved.grant_id,
        status: reserved.grant_status
      });
    }

    if (reserved.grant_stripe_checkout_session_id) {
      const priorSession = await stripe.checkout.sessions.retrieve(
        reserved.grant_stripe_checkout_session_id
      );
      if (priorSession.status === 'open' && priorSession.url) {
        return json(200, {
          ok: true,
          idempotent: true,
          reward_grant_id: reserved.grant_id,
          status: 'claimed',
          destination: 'checkout',
          url: priorSession.url
        });
      }
    }

    grant = {
      ...grant,
      status: reserved.grant_status,
      idempotency_key: reserved.grant_idempotency_key,
      notes: reserved.grant_notes || grant.notes || {}
    };

    const resource = await validateRewardResource(grant.reward_variant);
    const operation = 'subscription_update';
    const lockToken = `reward_lock_${user.id}_${grant.id}`;
    const { data: acquired, error: lockError } = await supabase.rpc(
      'acquire_fintrail_reward_billing_lock',
      {
        p_user_id: user.id,
        p_reward_grant_id: grant.id,
        p_lock_token: lockToken,
        p_operation: operation,
        p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      }
    );
    if (lockError) throw lockError;
    lockAcquired = acquired === true;
    if (!lockAcquired) {
      const scheduled = await scheduleGrant(
        supabase,
        grant,
        'another_reward_billing_operation_is_in_progress',
        null
      );
      return json(202, {
        ok: true,
        reward_grant_id: grant.id,
        ...scheduled
      });
    }

    const { data: billingRow, error: billingError } = await supabase
      .from('user_data')
      .select('stripe_customer_id,stripe_subscription_id,subscription_status')
      .eq('user_id', user.id)
      .maybeSingle();
    if (billingError) throw billingError;

    const customers = await listCustomersByEmail(user.email.trim().toLowerCase());
    let customer = null;

    // A stored Stripe customer ID is immutable in the claim engine. Retrieve
    // and reuse it directly, even if the user's email has since changed.
    if (billingRow?.stripe_customer_id) {
      try {
        customer = await stripe.customers.retrieve(billingRow.stripe_customer_id);
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
      }
      if (!customer || customer.deleted) {
        const scheduled = await scheduleGrant(
          supabase,
          grant,
          'stored_stripe_customer_requires_reconciliation',
          null
        );
        await releaseLock(supabase, user.id, grant.id);
        lockAcquired = false;
        return json(409, {
          ok: false,
          reward_grant_id: grant.id,
          ...scheduled
        });
      }
      if (!customers.some(item => item.id === customer.id)) {
        customers.unshift(customer);
      }
    } else {
      customer = customers[0] || null;
    }

    const subscription = await findExistingSubscription(
      customers,
      billingRow?.stripe_subscription_id
    );
    if (subscription) {
      if (billingRow?.stripe_customer_id && subscription.customer !== customer.id) {
        const scheduled = await scheduleGrant(
          supabase,
          grant,
          'stripe_customer_subscription_mismatch_requires_reconciliation',
          null
        );
        await releaseLock(supabase, user.id, grant.id);
        lockAcquired = false;
        return json(409, {
          ok: false,
          reward_grant_id: grant.id,
          ...scheduled
        });
      }
      if (!billingRow?.stripe_customer_id) {
        customer = customers.find(item => item.id === subscription.customer);
        if (!customer) customer = await stripe.customers.retrieve(subscription.customer);
      }
    }

    if (
      grant.stripe_customer_id &&
      customer &&
      grant.stripe_customer_id !== customer.id
    ) {
      const scheduled = await scheduleGrant(
        supabase,
        grant,
        'reward_customer_identity_requires_reconciliation',
        null
      );
      await releaseLock(supabase, user.id, grant.id);
      lockAcquired = false;
      return json(409, {
        ok: false,
        reward_grant_id: grant.id,
        ...scheduled
      });
    }

    const openCheckout = await findOpenCheckout(customers);
    if (!subscription && openCheckout) {
      const scheduled = await scheduleGrant(
        supabase,
        grant,
        'subscription_checkout_already_open',
        null
      );
      await releaseLock(supabase, user.id, grant.id);
      lockAcquired = false;
      return json(202, {
        ok: true,
        reward_grant_id: grant.id,
        existing_checkout_session_id: openCheckout.id,
        ...scheduled
      });
    }

    if (!customer) {
      customer = await stripe.customers.create({
        email: user.email.trim().toLowerCase(),
        metadata: { fintrail_user_id: user.id }
      }, {
        idempotencyKey: `fintrail_customer_${user.id}`
      });
    }

    const billingIdentityUpdate = {
      user_id: user.id,
      updated_at: new Date().toISOString()
    };
    if (!billingRow?.stripe_customer_id) {
      billingIdentityUpdate.stripe_customer_id = customer.id;
    }
    if (subscription && !billingRow?.stripe_subscription_id) {
      billingIdentityUpdate.stripe_subscription_id = subscription.id;
      billingIdentityUpdate.subscription_status = subscription.status;
    }

    const { error: customerSaveError } = await supabase
      .from('user_data')
      .upsert(billingIdentityUpdate, { onConflict: 'user_id' });
    if (customerSaveError) throw customerSaveError;

    if (!subscription) {
      const lineItemPrice = resource.kind === 'price'
        ? resource.resourceId
        : process.env.STRIPE_PRICE_ID;
      if (!lineItemPrice) throw new Error('STRIPE_PRICE_ID is not configured');

      const sessionParams = {
        payment_method_types: ['card'],
        mode: 'subscription',
        customer: customer.id,
        client_reference_id: user.id,
        metadata: {
          fintrail_user_id: user.id,
          fintrail_reward_grant_id: grant.id
        },
        line_items: [{ price: lineItemPrice, quantity: 1 }],
        subscription_data: {
          metadata: {
            fintrail_user_id: user.id,
            fintrail_reward_grant_id: grant.id,
            fintrail_reward_variant: grant.reward_variant
          }
        },
        success_url: 'https://fintrail.app?upgraded=true',
        cancel_url: 'https://fintrail.app?cancelled=true'
      };
      if (resource.kind === 'coupon') {
        sessionParams.discounts = [{ coupon: resource.resourceId }];
      }

      const session = await stripe.checkout.sessions.create(
        sessionParams,
        { idempotencyKey: `fintrail_reward_checkout_${grant.id}` }
      );
      await updateGrant(supabase, grant.id, {
        stripe_customer_id: customer.id,
        stripe_checkout_session_id: session.id,
        notes: {
          ...(grant.notes || {}),
          claim_path: 'checkout'
        }
      });

      // Keep the per-user lock until Checkout completes or expires.
      await supabase
        .from('reward_billing_locks')
        .update({
          operation: 'checkout',
          expires_at: new Date((session.expires_at || Math.floor(Date.now() / 1000) + 86400) * 1000).toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('user_id', user.id)
        .eq('reward_grant_id', grant.id);

      console.log('FINTRAIL REWARD CHECKOUT CREATED', JSON.stringify({
        user_id: user.id,
        reward_grant_id: grant.id,
        tier: grant.tier,
        checkout_session_id: session.id
      }));
      return json(200, {
        ok: true,
        reward_grant_id: grant.id,
        status: 'claimed',
        destination: 'checkout',
        url: session.url
      });
    }

    const { data: competingGrants, error: competingError } = await supabase
      .from('reward_grants')
      .select('id,status,activation_not_before')
      .eq('user_id', user.id)
      .neq('id', grant.id)
      .in('status', ['claimed', 'active']);
    if (competingError) throw competingError;

    const discountEnd = getActiveDiscountEnd(subscription);
    const trialEnd = subscription.status === 'trialing' ? subscription.trial_end : null;
    const hasAttachedSchedule = !!subscription.schedule;
    if (
      competingGrants?.length ||
      discountEnd ||
      trialEnd ||
      subscription.status === 'past_due' ||
      subscription.status === 'unpaid' ||
      subscription.status === 'paused' ||
      subscription.status === 'incomplete' ||
      subscription.cancel_at_period_end === true ||
      hasAttachedSchedule
    ) {
      const safeStartSeconds =
        discountEnd ||
        trialEnd ||
        subscription.current_period_end ||
        null;
      const scheduled = await scheduleGrant(
        supabase,
        grant,
        competingGrants?.length ? 'another_reward_is_active' :
          discountEnd ? 'existing_stripe_discount_is_active' :
          trialEnd ? 'subscription_trial_is_active' :
          subscription.status === 'past_due' ? 'subscription_is_past_due' :
          subscription.status === 'unpaid' ? 'subscription_is_unpaid' :
          subscription.status === 'paused' ? 'subscription_is_paused' :
          subscription.status === 'incomplete' ? 'subscription_is_incomplete' :
          subscription.cancel_at_period_end === true ? 'subscription_cancellation_is_pending' :
          'subscription_schedule_is_attached',
        safeStartSeconds
          ? new Date(safeStartSeconds * 1000).toISOString()
          : null
      );
      await releaseLock(supabase, user.id, grant.id);
      lockAcquired = false;
      return json(202, {
        ok: true,
        reward_grant_id: grant.id,
        ...scheduled
      });
    }

    await updateGrant(supabase, grant.id, {
      stripe_customer_id: customer.id,
      stripe_subscription_id: subscription.id,
      notes: {
        ...(grant.notes || {}),
        claim_path: 'existing_subscription'
      }
    });

    const metadata = {
      ...subscription.metadata,
      fintrail_user_id: user.id,
      fintrail_reward_grant_id: grant.id,
      fintrail_reward_variant: grant.reward_variant
    };

    if (resource.kind === 'coupon') {
      await stripe.subscriptions.update(subscription.id, {
        discounts: [{ coupon: resource.resourceId }],
        metadata
      }, {
        idempotencyKey: `fintrail_reward_subscription_${grant.id}`
      });
    } else {
      const subscriptionItem = subscription.items?.data?.[0];
      if (!subscriptionItem?.id) {
        throw new Error('Existing subscription has no updatable item');
      }
      await stripe.subscriptions.update(subscription.id, {
        items: [{
          id: subscriptionItem.id,
          price: resource.resourceId,
          quantity: subscriptionItem.quantity || 1
        }],
        proration_behavior: 'none',
        metadata
      }, {
        idempotencyKey: `fintrail_reward_subscription_${grant.id}`
      });
    }

    await releaseLock(supabase, user.id, grant.id);
    lockAcquired = false;
    console.log('FINTRAIL REWARD SUBSCRIPTION UPDATE REQUESTED', JSON.stringify({
      user_id: user.id,
      reward_grant_id: grant.id,
      tier: grant.tier,
      stripe_subscription_id: subscription.id
    }));
    return json(200, {
      ok: true,
      reward_grant_id: grant.id,
      status: 'claimed',
      destination: 'existing_subscription',
      awaiting_webhook_confirmation: true
    });
  } catch (error) {
    console.log('Fintrail reward claim error:', error.message);
    if (grant?.id) {
      try {
        await updateGrant(supabase, grant.id, {
          status: 'failed',
          notes: {
            ...(grant.notes || {}),
            last_error: 'reward_application_failed',
            failed_at: new Date().toISOString()
          }
        });
      } catch (updateError) {
        console.log('Reward failure status update error:', updateError.message);
      }
    }
    if (lockAcquired && user?.id && grant?.id) {
      await releaseLock(supabase, user.id, grant.id);
    }
    return json(500, { error: 'Reward claim failed' });
  }
};
