// Fintrail Cancel Subscription Function
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const { email } = JSON.parse(event.body);

    // Find customer by email
    const customers = await stripe.customers.list({ email: email, limit: 1 });
    if (customers.data.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No customer found' }) };
    }

    const customer = customers.data[0];

    // Get active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No active subscription found' }) };
    }

    // Cancel at end of billing period (not immediately)
    const subscription = await stripe.subscriptions.update(
      subscriptions.data[0].id,
      { cancel_at_period_end: true }
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Subscription will cancel at end of billing period',
        cancel_at: new Date(subscription.cancel_at * 1000).toLocaleDateString()
      })
    };
  } catch (err) {
    console.log('Cancel error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
