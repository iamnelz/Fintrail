const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const FREE_DAILY_AI_LIMIT = 5;

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Please sign in to use the AI Advisor.' }) };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: authData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !authData?.user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session. Please sign in again.' }) };
  }

  const user = authData.user;
  const today = new Date().toISOString().slice(0, 10);

  let { data: userData, error: userDataError } = await supabase
    .from('user_data')
    .select('user_id, is_pro, ai_prompts_used_today, ai_prompt_reset_date')
    .eq('user_id', user.id)
    .single();

  if (userDataError && userDataError.code !== 'PGRST116') {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not check your AI usage.' }) };
  }

  if (!userData) {
    const { data: createdData, error: createError } = await supabase
      .from('user_data')
      .insert({
        user_id: user.id,
        is_pro: false,
        ai_prompts_used_today: 0,
        ai_prompt_reset_date: today
      })
      .select('user_id, is_pro, ai_prompts_used_today, ai_prompt_reset_date')
      .single();

    if (createError) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create usage record.' }) };
    }

    userData = createdData;
  }

  let usedToday = userData.ai_prompts_used_today || 0;

  if (userData.ai_prompt_reset_date !== today) {
    usedToday = 0;

    await supabase
      .from('user_data')
      .update({
        ai_prompts_used_today: 0,
        ai_prompt_reset_date: today
      })
      .eq('user_id', user.id);
  }

  const isPro = !!userData.is_pro;

  if (!isPro && usedToday >= FREE_DAILY_AI_LIMIT) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: 'You’ve used your 5 free AI prompts for today. Upgrade to Pro for unlimited AI guidance.',
        limitReached: true,
        used: usedToday,
        limit: FREE_DAILY_AI_LIMIT
      })
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { messages, system } = body;
  if (!messages || !Array.isArray(messages)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'messages array required' }) };
  }

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: system || 'You are a helpful financial advisor.',
    messages
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };

  try {
    const result = await httpsPost(options, requestBody);

    if (result.status !== 200) {
      return {
        statusCode: result.status,
        headers,
        body: JSON.stringify({ error: result.body?.error?.message || 'Anthropic API error' })
      };
    }

    const reply = (result.body.content || []).map(b => b.text || '').join('');

    if (!isPro) {
      usedToday += 1;

      await supabase
        .from('user_data')
        .update({
          ai_prompts_used_today: usedToday,
          ai_prompt_reset_date: today
        })
        .eq('user_id', user.id);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply,
        aiUsage: isPro
          ? { unlimited: true }
          : { used: usedToday, limit: FREE_DAILY_AI_LIMIT, remaining: Math.max(0, FREE_DAILY_AI_LIMIT - usedToday) }
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
