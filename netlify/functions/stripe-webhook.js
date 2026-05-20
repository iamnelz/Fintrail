// Fintrail Stripe Webhook Function
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event) {
  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.log('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Initialize Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    switch (stripeEvent.type) {

      // Payment succeeded — upgrade user to Pro
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const email = session.customer_email;
        console.log('New Pro subscriber:', email);

        // Update user in Supabase
        const { data: user } = await supabase
          .from('auth.users')
          .select('id')
          .eq('email', email)
          .single();

        if (user) {
          await supabase
            .from('user_data')
            .upsert({ user_id: user.id, is_pro: true }, { onConflict: 'user_id' });
        }
        break;
      }

      // Subscription renewed — keep Pro active
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        const email = invoice.customer_email;
        console.log('Subscription renewed:', email);
        break;
      }

      // Payment failed — notify but keep access briefly
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        console.log('Payment failed for:', invoice.customer_email);
        break;
      }

      // Subscription cancelled — downgrade to free
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        console.log('Subscription cancelled:', email);

        // Downgrade user in Supabase
        const { data: user } = await supabase
          .from('auth.users')
          .select('id')
          .eq('email', email)
          .single();

        if (user) {
          await supabase
            .from('user_data')
            .update({ is_pro: false })
            .eq('user_id', user.id);
        }
        break;
      }

      // Subscription ending at period end
      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object;
        if (subscription.cancel_at_period_end) {
          const customer = await stripe.customers.retrieve(subscription.customer);
          console.log('Subscription will cancel:', customer.email);
        }
        break;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.log('Webhook handler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
