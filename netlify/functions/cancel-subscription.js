// Fintrail Cancel Subscription - Stripe Customer Portal
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const { email } = JSON.parse(event.body);
    console.log('Portal request for:', email);

    const customers = await stripe.customers.list({ email: email, limit: 1 });
    console.log('Customers found:', customers.data.length);

    if (customers.data.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No customer found' }) };
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: 'https://fintrail.app',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    console.log('Portal error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
