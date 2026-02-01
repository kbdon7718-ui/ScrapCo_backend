function isDevBypassAllowed() {
  return String(process.env.ALLOW_DEV_BYPASS || '').toLowerCase() === 'true';
}

async function pickOrCreateDevCustomerId(serviceClient) {
  const explicit = String(process.env.DEV_CUSTOMER_ID || '').trim();
  if (explicit) return explicit;

  // Prefer an existing profile id if present.
  const { data: profileRow, error: profileErr } = await serviceClient
    .from('profiles')
    .select('id')
    .limit(1)
    .maybeSingle();

  if (!profileErr && profileRow?.id) return profileRow.id;

  // Fall back to Auth users (service role only). If there are no users,
  // create a deterministic dev user so dev bypass works out of the box.
  const { data: usersData, error: usersErr } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (usersErr) {
    throw new Error(usersErr.message || 'Could not list users to pick a dev customer.');
  }

  const firstUser = usersData?.users?.[0];
  if (firstUser?.id) return firstUser.id;

  const devEmail = String(process.env.DEV_CUSTOMER_EMAIL || 'dev.customer@scrapco.local').trim();
  const devPassword = String(process.env.DEV_CUSTOMER_PASSWORD || 'DevPassword123!').trim();

  const { data: created, error: createErr } = await serviceClient.auth.admin.createUser({
    email: devEmail,
    password: devPassword,
    email_confirm: true,
    user_metadata: { role: 'customer', signup_source: 'dev_bypass' },
  });

  if (createErr || !created?.user?.id) {
    throw new Error(createErr?.message || 'Could not auto-create a dev user. Set DEV_CUSTOMER_ID in backend/.env.');
  }

  return created.user.id;
}

async function ensureDevProfile(serviceClient, customerId) {
  const { error } = await serviceClient.from('profiles').upsert({ id: customerId, role: 'customer' }, { onConflict: 'id' });
  if (error) {
    throw new Error(
      error.message || 'Could not ensure profile exists. Set DEV_CUSTOMER_ID to a valid auth.users id in backend/.env.'
    );
  }
}

module.exports = {
  isDevBypassAllowed,
  pickOrCreateDevCustomerId,
  ensureDevProfile,
};
