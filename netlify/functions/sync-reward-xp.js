// Fintrail verified XP bridge.
// The browser supplies only its Supabase access token. XP, tier, rewards,
// discounts, and eligibility are always read and decided server-side.
const { createClient } = require('@supabase/supabase-js');

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

function readStoredAppXp(gameData) {
  let value = gameData;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error('Stored game data is invalid');
    }
  }
  const xp = Number(value?.totalXP);
  if (!Number.isSafeInteger(xp) || xp < 0) {
    throw new Error('Stored XP is invalid');
  }
  return xp;
}

function getPromotionEnd() {
  const value = new Date(process.env.FOUNDING_MEMBER_PROMOTION_END || '');
  if (Number.isNaN(value.getTime())) {
    throw new Error('FOUNDING_MEMBER_PROMOTION_END is invalid');
  }
  return value;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON body' });
  }
  if (Object.keys(body).length !== 0) {
    return json(400, {
      error: 'XP, tier, reward, and eligibility values cannot be submitted'
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  try {
    const user = await getAuthenticatedUser(event, supabase);
    if (!user?.id) {
      return json(401, { error: 'Authentication required' });
    }

    const { data: userData, error: userDataError } = await supabase
      .from('user_data')
      .select('game_data')
      .eq('user_id', user.id)
      .maybeSingle();
    if (userDataError) throw userDataError;
    if (!userData?.game_data) {
      return json(409, { error: 'No synchronized app XP is available yet' });
    }

    const storedAppXp = readStoredAppXp(userData.game_data);
    const { data: previousAccount, error: previousError } = await supabase
      .from('reward_accounts')
      .select(
        'user_id,verified_xp,highest_tier,verified_xp_updated_at,' +
        'founding_status_verified,diamond_reward_variant'
      )
      .eq('user_id', user.id)
      .maybeSingle();
    if (previousError) throw previousError;

    const previousVerifiedXp = Math.max(0, Number(previousAccount?.verified_xp || 0));
    const requestedVerifiedXp = Math.max(previousVerifiedXp, storedAppXp);

    const { error: progressError } = await supabase.rpc(
      'record_fintrail_reward_progress',
      {
        p_user_id: user.id,
        p_verified_xp: requestedVerifiedXp,
        p_is_founding_member: null
      }
    );
    if (progressError) throw progressError;

    let { data: account, error: accountError } = await supabase
      .from('reward_accounts')
      .select(
        'user_id,verified_xp,highest_tier,verified_xp_updated_at,' +
        'founding_status_verified,diamond_reward_variant'
      )
      .eq('user_id', user.id)
      .single();
    if (accountError) throw accountError;

    if (
      Number(account.verified_xp) >= 35000 &&
      !account.founding_status_verified &&
      !account.diamond_reward_variant
    ) {
      const earnedAt = new Date(account.verified_xp_updated_at);
      if (Number.isNaN(earnedAt.getTime())) {
        throw new Error('Verified XP timestamp is missing');
      }
      const { error: lockError } = await supabase.rpc(
        'lock_fintrail_diamond_eligibility',
        {
          p_user_id: user.id,
          p_is_founding_eligible: earnedAt <= getPromotionEnd(),
          p_diamond_earned_at: earnedAt.toISOString()
        }
      );
      if (lockError) throw lockError;
    }

    const { data: evaluation, error: evaluationError } = await supabase.rpc(
      'evaluate_fintrail_rewards',
      { p_user_id: user.id }
    );
    if (evaluationError) throw evaluationError;

    const finalAccountResult = await supabase
      .from('reward_accounts')
      .select('verified_xp,highest_tier,verified_xp_updated_at')
      .eq('user_id', user.id)
      .single();
    if (finalAccountResult.error) throw finalAccountResult.error;
    account = finalAccountResult.data;

    const result = {
      ok: true,
      source: 'user_data.game_data.totalXP',
      previous_verified_xp: previousVerifiedXp,
      stored_app_xp: storedAppXp,
      verified_xp: Number(account.verified_xp),
      highest_tier: account.highest_tier,
      changed: Number(account.verified_xp) > previousVerifiedXp,
      evaluation: evaluation || []
    };
    console.log('FINTRAIL VERIFIED XP SYNC', JSON.stringify({
      user_id: user.id,
      previous_verified_xp: result.previous_verified_xp,
      verified_xp: result.verified_xp,
      highest_tier: result.highest_tier,
      changed: result.changed
    }));
    return json(200, result);
  } catch (error) {
    console.log('Fintrail verified XP sync error:', error.message);
    return json(500, { error: 'Verified XP sync failed' });
  }
};
