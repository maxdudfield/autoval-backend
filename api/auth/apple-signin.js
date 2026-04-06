// POST /api/auth/apple-signin
// Called after Sign in with Apple succeeds on device.
// Creates or finds the user in Supabase, returns a session profile.
// No Supabase auth JWT is issued — we use apple_user_id as the stable identifier.

const { checkAppSecret } = require('../_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10kb' } },
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const { apple_user_id, email, full_name } = req.body ?? {};

  if (!apple_user_id || typeof apple_user_id !== 'string') {
    return res.status(400).json({ error: 'apple_user_id required' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email required' });
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  const normEmail = email.toLowerCase().trim();
  const now = new Date().toISOString();

  console.log(`[apple-signin] ▶ apple_id=${apple_user_id.slice(0, 8)}… email=${normEmail}`);

  // Try to find existing user by apple_user_id first, then fall back to email
  const { data: byAppleId } = await supabase
    .from('users')
    .select('*')
    .eq('apple_user_id', apple_user_id)
    .maybeSingle();

  const { data: byEmail } = !byAppleId
    ? await supabase.from('users').select('*').eq('email', normEmail).maybeSingle()
    : { data: null };

  const existing = byAppleId ?? byEmail;
  let profile;
  let isNewUser = false;

  if (existing) {
    // Returning user — update last_seen and backfill apple_user_id if needed
    const updates = {
      last_seen_at: now,
      apple_user_id,
      sign_in_provider: 'apple',
    };
    if (full_name && !existing.display_name) updates.display_name = full_name;

    const { data: updated, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) console.error('[apple-signin] update error:', error.message);
    profile = updated ?? existing;
  } else {
    // New user
    isNewUser = true;
    const { data: created, error } = await supabase
      .from('users')
      .insert({
        email: normEmail,
        apple_user_id,
        display_name: full_name ?? null,
        sign_in_provider: 'apple',
        created_from: 'ios_apple',
        last_seen_at: now,
      })
      .select()
      .single();

    if (error) {
      console.error('[apple-signin] insert error:', error.message);
      // Return minimal profile so sign-in still works even if DB write failed
      return res.status(200).json({
        user_id:              apple_user_id,
        email:                normEmail,
        display_name:         full_name ?? null,
        is_new_user:          true,
        is_pro:               false,
        free_scans_remaining: 3,
        total_scans:          0,
        member_since:         now,
        sign_in_provider:     'apple',
      });
    }
    profile = created;
  }

  console.log(`[apple-signin] ✓ ${isNewUser ? 'new' : 'returning'} user pro=${profile.is_pro}`);

  return res.status(200).json({
    user_id:              profile.id,
    email:                profile.email,
    display_name:         profile.display_name ?? null,
    is_new_user:          isNewUser,
    is_pro:               profile.is_pro ?? false,
    free_scans_remaining: profile.free_scans_remaining ?? 3,
    total_scans:          profile.total_scans ?? 0,
    member_since:         profile.created_at,
    sign_in_provider:     'apple',
  });
};
