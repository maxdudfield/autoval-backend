// DELETE /api/user/delete
// Permanently deletes a user account and associated data.
// - Deletes garage_cars for the user
// - Anonymises scans (sets user_id to null, preserves anonymous data)
// - Deletes the user from the users table and Supabase auth
// Requires: x-autoval-secret header + { user_id } body.

const { checkAppSecret, sanitiseError } = require('../_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkAppSecret(req, ip)) return res.status(401).json({ error: 'Unauthorised' });

  const { user_id } = req.body ?? {};
  if (!user_id || typeof user_id !== 'string' || user_id.trim().length === 0) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  try {
    // 1. Delete garage cars
    const { error: garageError } = await supabase
      .from('garage_cars')
      .delete()
      .eq('user_id', user_id);

    if (garageError) {
      console.error(`[user/delete] garage_cars delete error for ${user_id.slice(0, 8)}…:`, garageError.message);
      // Non-fatal — continue
    }

    // 2. Anonymise scans (preserve anonymous data, remove user link)
    const { error: scansError } = await supabase
      .from('scans')
      .update({ user_id: null })
      .eq('user_id', user_id);

    if (scansError) {
      console.error(`[user/delete] scans anonymise error for ${user_id.slice(0, 8)}…:`, scansError.message);
      // Non-fatal — continue
    }

    // 3. Delete from users table
    const { error: userTableError } = await supabase
      .from('users')
      .delete()
      .eq('id', user_id);

    if (userTableError) {
      console.error(`[user/delete] users table delete error for ${user_id.slice(0, 8)}…:`, userTableError.message);
      // Non-fatal — Supabase auth delete is the authoritative step
    }

    // 4. Delete from Supabase auth (requires service key)
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user_id);
    if (authDeleteError) {
      console.error(`[user/delete] auth.admin.deleteUser error for ${user_id.slice(0, 8)}…:`, authDeleteError.message);
      return res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
    }

    console.log(`[user/delete] account deleted for user ${user_id.slice(0, 8)}…`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[user/delete] unexpected error:', err.message);
    return res.status(500).json({ error: sanitiseError(err) });
  }
};
