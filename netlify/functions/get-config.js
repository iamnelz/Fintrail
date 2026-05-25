// netlify/functions/get-config.js
// Place at: netlify/functions/get-config.js in your project root
// Set these in Netlify → Site Settings → Environment Variables:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

exports.handler = async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Supabase env vars not set' })
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify({
      supabaseUrl,
      supabaseAnonKey
    })
  };
};
