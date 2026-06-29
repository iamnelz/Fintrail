// Fintrail Rewards Engine - Phase 2B
// Internal/service-only evaluator. It never accepts XP, tier, discounts,
// coupons, Stripe prices, or Diamond eligibility from a browser.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const suppliedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));
  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function getPromotionEnd() {
  const raw = process.env.FOUNDING_MEMBER_PROMOTION_END;
  if (!raw) throw new Error('FOUNDING_MEMBER_PROMOTION_END is not configured');
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new Error('FOUNDING_MEMBER_PROMOTION_END is invalid');
  }
  return value;
}

async function evaluateUser(supabase, account) {
  let diamondVariant = account.diamond_reward_variant || null;

  if (
    Number(account.verified_xp) >= 35000 &&
    !account.founding_status_verified &&
    !diamondVariant
  ) {
    const earnedAt = new Date(account.verified_xp_updated_at);
    if (Number.isNaN(earnedAt.getTime())) {
      throw new Error(`Missing verified XP timestamp for ${account.user_id}`);
    }
    const foundingEligible = earnedAt <= getPromotionEnd();
    const { data: lockedVariant, error: lockError } = await supabase.rpc(
      'lock_fintrail_diamond_eligibility',
      {
        p_user_id: account.user_id,
        p_is_founding_eligible: foundingEligible,
        p_diamond_earned_at: earnedAt.toISOString()
      }
    );
    if (lockError) throw lockError;
    diamondVariant = lockedVariant;
  }

  const { data: rewards, error } = await supabase.rpc(
    'evaluate_fintrail_rewards',
    { p_user_id: account.user_id }
  );
  if (error) throw error;

  const granted = (rewards || []).filter(item => item.action === 'granted');
  const output = {
    user_id: account.user_id,
    verified_xp: Number(account.verified_xp),
    evaluated_tier:
      Number(account.verified_xp) >= 35000 ? 'diamond' :
      Number(account.verified_xp) >= 18000 ? 'platinum' :
      Number(account.verified_xp) >= 9000 ? 'gold' :
      Number(account.verified_xp) >= 4000 ? 'silver' : 'bronze',
    diamond_variant_locked: diamondVariant,
    grants_created: granted,
    rewards: rewards || []
  };

  console.log('FINTRAIL REWARDS EVALUATION', JSON.stringify(output));
  return output;
}

async function loadOrCreateRewardAccount(supabase, userId) {
  const fields =
    'user_id,verified_xp,verified_xp_updated_at,highest_tier,' +
    'founding_status_verified,diamond_reward_variant';
  const { data: existingAccount, error: readError } = await supabase
    .from('reward_accounts')
    .select(fields)
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw readError;
  if (existingAccount) {
    return { account: existingAccount, created: false };
  }

  const { error: createError } = await supabase
    .from('reward_accounts')
    .insert({
      user_id: userId,
      verified_xp: 0,
      highest_tier: 'bronze'
    });
  if (createError && createError.code !== '23505') throw createError;

  // Re-read after insert so concurrent evaluations resolve to the same
  // unique user_id row without creating duplicate accounts.
  const { data: initializedAccount, error: initializedReadError } = await supabase
    .from('reward_accounts')
    .select(fields)
    .eq('user_id', userId)
    .maybeSingle();
  if (initializedReadError) throw initializedReadError;
  if (!initializedAccount) {
    throw new Error(`Unable to initialize reward account for ${userId}`);
  }

  return {
    account: initializedAccount,
    created: !createError
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const suppliedSecret =
    event.headers['x-fintrail-rewards-secret'] ||
    event.headers['X-Fintrail-Rewards-Secret'];
  if (!secretsMatch(suppliedSecret, process.env.REWARDS_ENGINE_SECRET)) {
    return json(401, { error: 'Unauthorized' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const forbiddenKeys = [
    'xp',
    'verified_xp',
    'tier',
    'reward',
    'reward_variant',
    'coupon',
    'coupon_id',
    'price',
    'price_id',
    'discount',
    'diamond_eligibility',
    'is_founding_member'
  ];
  if (forbiddenKeys.some(key => Object.prototype.hasOwnProperty.call(body, key))) {
    return json(400, { error: 'Reward eligibility values cannot be submitted' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  try {
    if (body.user_id) {
      const rewardAccount = await loadOrCreateRewardAccount(
        supabase,
        body.user_id
      );
      return json(200, {
        ok: true,
        reward_account_created: rewardAccount.created,
        reward_account_status: rewardAccount.created ? 'created' : 'existing',
        result: await evaluateUser(supabase, rewardAccount.account)
      });
    }

    if (body.all !== true) {
      return json(400, { error: 'Provide user_id or all: true' });
    }

    const results = [];
    const errors = [];
    const pageSize = 500;
    let from = 0;

    while (true) {
      const { data: accounts, error } = await supabase
        .from('reward_accounts')
        .select(
          'user_id,verified_xp,verified_xp_updated_at,highest_tier,' +
          'founding_status_verified,diamond_reward_variant'
        )
        .order('user_id')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!accounts?.length) break;

      for (const account of accounts) {
        try {
          results.push(await evaluateUser(supabase, account));
        } catch (error) {
          const failure = {
            user_id: account.user_id,
            error: error.message
          };
          errors.push(failure);
          console.log('FINTRAIL REWARDS EVALUATION ERROR', JSON.stringify(failure));
        }
      }

      if (accounts.length < pageSize) break;
      from += pageSize;
    }

    return json(errors.length ? 207 : 200, {
      ok: errors.length === 0,
      evaluated: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (error) {
    console.log('Fintrail rewards engine error:', error.message);
    return json(500, { error: 'Rewards evaluation failed' });
  }
};
