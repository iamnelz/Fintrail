// Fintrail Stripe Checkout Function - duplicate subscription protected
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { email } = JSON.parse(event.body);

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email is required' })
      };
    }

    // Find or create Stripe customer
    const existingCustomers = await stripe.customers.list({
      email,
      limit: 1
    });

    let customer = existingCustomers.data[0];

    if (!customer) {
      customer = await stripe.customers.create({ email });
    }

    // Check if this customer already has an active/trialing subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 100
    });

    const activeSubscription = subscriptions.data.find(sub =>
      ['active', 'trialing', 'past_due'].includes(sub.status)
    );

    if (activeSubscription) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'You already have an active Pro subscription.',
          alreadySubscribed: true
        })
      };
    }

    // Create checkout only if no active subscription exists
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer: customer.id,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      subscription_data: {
        trial_period_days: 7
      },
      success_url: 'https://fintrail.app?upgraded=true',
      cancel_url: 'https://fintrail.app?cancelled=true',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    console.log('Stripe error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
