// Fintrail Stripe Customer Diagnostic - read-only billing incident report
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function authorized(event) {
  const header =
    event.headers['x-fintrail-billing-diagnostic-secret'] ||
    event.headers['X-Fintrail-Billing-Diagnostic-Secret'] ||
    '';
  return !!process.env.FINTRAIL_BILLING_DIAGNOSTIC_SECRET &&
    header === process.env.FINTRAIL_BILLING_DIAGNOSTIC_SECRET;
}

async function getAuthenticatedUser(event, supabase) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function isOwnerOrAdminUser(user) {
  const ownerIds = [
    ...envList('FINTRAIL_OWNER_USER_IDS'),
    ...envList('FINTRAIL_ADMIN_USER_IDS')
  ];
  const ownerEmails = [
    ...envList('FINTRAIL_OWNER_EMAILS'),
    ...envList('FINTRAIL_ADMIN_EMAILS')
  ].map(normalizeEmail);
  return ownerIds.includes(user?.id) || ownerEmails.includes(normalizeEmail(user?.email));
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

function summarizeSubscription(subscription) {
  return {
    id: subscription.id,
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    metadata: subscription.metadata || {},
    item_price_ids: (subscription.items?.data || []).map(item => item.price?.id).filter(Boolean)
  };
}

function summarizeInvoice(invoice) {
  return {
    id: invoice.id,
    customer: invoice.customer || null,
    status: invoice.status,
    subscription: invoice.subscription || null,
    total: invoice.total,
    amount_paid: invoice.amount_paid,
    currency: invoice.currency,
    created: invoice.created ? new Date(invoice.created * 1000).toISOString() : null,
    hosted_invoice_url: invoice.hosted_invoice_url || null
  };
}

function customerMetadataUserId(customer) {
  return customer?.metadata?.supabase_user_id || customer?.metadata?.fintrail_user_id || null;
}

function latestInvoiceFor(customerReport) {
  return [...(customerReport.invoices || [])].sort((a, b) =>
    new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime()
  )[0] || null;
}

function traceSelection({ profile, customers, userId }) {
  const currentCustomerId = profile?.stripe_customer_id || null;
  const mappedCustomer = currentCustomerId
    ? customers.find(customer => customer.id === currentCustomerId)
    : null;
  const metadataMatch = customers.find(customer => customerMetadataUserId(customer) === userId);
  const legacyFallback = customers.find(customer => !customerMetadataUserId(customer));

  let reason = 'no_customer_mapping_found';
  let reasonLabel = 'No customer mapping found';
  if (currentCustomerId) {
    reason = 'stored_stripe_customer_id';
    reasonLabel = 'Stored stripe_customer_id in Supabase';
  } else if (metadataMatch) {
    reason = 'stripe_metadata_match';
    reasonLabel = 'Stripe metadata matched Supabase user ID';
  } else if (legacyFallback) {
    reason = 'controlled_legacy_email_fallback';
    reasonLabel = 'Controlled legacy email fallback';
  }

  return {
    selected_customer_id: currentCustomerId || metadataMatch?.id || legacyFallback?.id || null,
    selected_because: reason,
    selected_because_label: reasonLabel,
    selection_order: [
      { key: 'stored_stripe_customer_id', label: 'Stored stripe_customer_id', used: reason === 'stored_stripe_customer_id' },
      { key: 'stripe_metadata_match', label: 'Metadata match', used: reason === 'stripe_metadata_match' },
      { key: 'controlled_legacy_email_fallback', label: 'Legacy email fallback', used: reason === 'controlled_legacy_email_fallback' }
    ],
    metadata_lookup: reason === 'stored_stripe_customer_id' ? 'not_needed' : metadataMatch ? 'matched' : 'no_match',
    legacy_email_fallback: reason === 'controlled_legacy_email_fallback' ? 'used' : 'not_used'
  };
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

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  try {
    const secretAuthorized = authorized(event);
    const authenticatedUser = await getAuthenticatedUser(event, supabase);
    const ownerAuthorized = isOwnerOrAdminUser(authenticatedUser);
    if (!secretAuthorized && !ownerAuthorized) {
      return json(authenticatedUser ? 403 : 401, { error: authenticatedUser ? 'Forbidden' : 'Unauthorized' });
    }

    if (body.mode === 'access_check') {
      return json(200, {
        ok: true,
        owner_admin: true,
        read_only: true
      });
    }

    const email = normalizeEmail(body.email || authenticatedUser?.email);
    const userId = String(body.user_id || authenticatedUser?.id || '').trim();
    if (!email && !userId) {
      return json(400, { error: 'Provide email or user_id' });
    }

    let profile = null;
    if (userId) {
      const { data, error } = await supabase
        .from('user_data')
        .select('user_id,stripe_customer_id,stripe_subscription_id,subscription_status,current_period_end,is_pro')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      profile = data || null;
    }

    const diagnosticEmail = email;
    const customers = diagnosticEmail ? await listCustomersByEmail(diagnosticEmail) : [];
    const customerReports = [];

    for (const customer of customers) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'all',
        limit: 100
      });
      const invoices = await stripe.invoices.list({
        customer: customer.id,
        limit: 20
      });
      customerReports.push({
        id: customer.id,
        email: customer.email,
        created: customer.created ? new Date(customer.created * 1000).toISOString() : null,
        metadata: customer.metadata || {},
        is_current_supabase_mapping: profile?.stripe_customer_id === customer.id,
        subscriptions: subscriptions.data.map(summarizeSubscription),
        invoices: invoices.data.map(summarizeInvoice)
      });
    }

    const activeLikeStatuses = new Set(['incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused']);
    const activeLikeSubscriptions = customerReports.flatMap(customer =>
      customer.subscriptions
        .filter(subscription =>
          activeLikeStatuses.has(subscription.status) ||
          subscription.cancel_at_period_end === true
        )
        .map(subscription => ({
          customer_id: customer.id,
          subscription_id: subscription.id,
          status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_end: subscription.current_period_end,
          most_recent_invoice: latestInvoiceFor(customer)
        }))
    );
    const currentCustomerId = profile?.stripe_customer_id || null;
    const duplicateBreakdown = customerReports.map(customer => {
      const latestInvoice = latestInvoiceFor(customer);
      const activeLikeCount = (customer.subscriptions || []).filter(subscription =>
        activeLikeStatuses.has(subscription.status) ||
        subscription.cancel_at_period_end === true
      ).length;
      const metadataUserId = customerMetadataUserId(customer);
      return {
        customer_id: customer.id,
        created: customer.created,
        email: customer.email,
        metadata_supabase_user_id: metadataUserId,
        current_mapping: customer.id === currentCustomerId,
        subscription_count: (customer.subscriptions || []).length,
        active_like_subscription_count: activeLikeCount,
        latest_invoice_date: latestInvoice?.created || null,
        latest_invoice_amount: latestInvoice?.amount_paid ?? latestInvoice?.total ?? null,
        latest_invoice_currency: latestInvoice?.currency || null,
        label: customer.id === currentCustomerId
          ? 'CURRENT'
          : metadataUserId
            ? 'LEGACY DUPLICATE'
            : 'UNMAPPED'
      };
    });
    const ownerAccountClean = activeLikeSubscriptions.length === 0;
    const proAccessSource = isOwnerOrAdminUser(authenticatedUser)
      ? 'Owner/Admin entitlement'
      : profile?.stripe_subscription_id
        ? 'Stripe subscription'
        : profile?.is_pro
          ? 'Other'
          : 'Other';
    const subscriptionTrace = {
      supabase_user_id: userId || null,
      account_email: diagnosticEmail || null,
      owner_admin: isOwnerOrAdminUser(authenticatedUser),
      current_mapped_stripe_customer_id: profile?.stripe_customer_id || null,
      current_mapped_subscription_id: profile?.stripe_subscription_id || null,
      subscription_status: profile?.subscription_status || null,
      current_period_end: profile?.current_period_end || null,
      pro_access_source: proAccessSource,
      ...traceSelection({ profile, customers: customerReports, userId })
    };

    return json(200, {
      ok: true,
      read_only: true,
      authenticated_owner_admin: ownerAuthorized || false,
      email: diagnosticEmail || null,
      user_id: userId || null,
      authenticated_user: authenticatedUser ? {
        id: authenticatedUser.id,
        email: authenticatedUser.email
      } : null,
      current_supabase_mapping: profile,
      customer_count: customerReports.length,
      active_like_subscription_count: activeLikeSubscriptions.length,
      active_like_subscriptions: activeLikeSubscriptions,
      owner_billing_state_clean: ownerAccountClean,
      subscription_resolution_trace: subscriptionTrace,
      duplicate_customer_breakdown: duplicateBreakdown,
      customers: customerReports,
      note: 'Diagnostic only. No customers, subscriptions, invoices, refunds, or Supabase rows were modified.'
    });
  } catch (error) {
    console.log('Stripe customer diagnostic error:', error.message);
    return json(500, { error: 'Unable to generate diagnostic report' });
  }
};
