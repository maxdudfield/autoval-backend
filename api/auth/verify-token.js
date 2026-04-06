// POST /api/auth/verify-token
// Verifies a Supabase access token from the magic-link callback.
// Creates or updates the user profile in the users table.
// Returns the user profile so the iOS app can store it.

const { checkAppSecret, sanitiseError } = require('../_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10kb' } },
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const { access_token } = req.body ?? {};
  if (!access_token || typeof access_token !== 'string') {
    return res.status(400).json({ error: 'access_token required' });
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  // Verify the JWT with Supabase
  const { data: { user }, error: authError } = await supabase.auth.getUser(access_token);
  if (authError || !user) {
    console.warn('[verify-token] Invalid token:', authError?.message);
    return res.status(401).json({ error: 'Invalid or expired sign-in link. Please request a new one.' });
  }

  console.log(`[verify-token] ▶ verified user ${user.id.slice(0, 8)}…`);

  // Upsert into our users table — creates on first sign-in, updates last_seen on return
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .upsert(
      { id: user.id, email: user.email, last_seen_at: new Date().toISOString() },
      { onConflict: 'id' }
    )
    .select()
    .single();

  if (profileError) {
    console.error('[verify-token] profile upsert error:', profileError.message);
    // Return minimal user info so sign-in still works
    return res.status(200).json({
      user_id:               user.id,
      email:                 user.email,
      is_new_user:           true,
      is_pro:                false,
      free_scans_remaining:  3,
      total_scans:           0,
      member_since:          new Date().toISOString(),
    });
  }

  const isNewUser = !profile.last_seen_at ||
    Math.abs(new Date(profile.created_at) - new Date(profile.last_seen_at)) < 5000;

  console.log(`[verify-token] ✓ ${isNewUser ? 'new' : 'returning'} user pro=${profile.is_pro}`);

  return res.status(200).json({
    user_id:               profile.id,
    email:                 profile.email,
    is_new_user:           isNewUser,
    is_pro:                profile.is_pro ?? false,
    free_scans_remaining:  profile.free_scans_remaining ?? 3,
    total_scans:           profile.total_scans ?? 0,
    member_since:          profile.created_at,
  });
};
