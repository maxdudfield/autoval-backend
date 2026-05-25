// GET /api/user/scans
// Returns the authenticated user's last 50 scans for cross-device history sync.
// Requires: Authorization: Bearer <access_token> header.

const { checkAppSecret, sanitiseError } = require('../_lib');
const { withErrorReporting } = require('../_lib/errorReporter');
const { createClient } = require('@supabase/supabase-js');

module.exports = withErrorReporting(async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const authHeader = req.headers.authorization ?? '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return res.status(401).json({ error: 'Authorization header required' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('[user/scans] SUPABASE_URL or SUPABASE_SERVICE_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const supabase = createClient(url, key);

  // Verify the token and get the user
  const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { data, error } = await supabase
    .from('scans')
    .select(`
      make, model, year, trim, body_type, colour,
      valuation_low, valuation_mid, valuation_high,
      confidence_score, market_insight,
      state, odometer, mileage_unknown,
      user_condition, scan_mode,
      scanned_at
    `)
    .eq('user_id', user.id)
    .order('scanned_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[user/scans] query error:', error.message);
    return res.status(500).json({ error: sanitiseError(error) });
  }

  console.log(`[user/scans] returned ${data?.length ?? 0} scans for user ${user.id.slice(0, 8)}…`);
  return res.status(200).json({ scans: data ?? [] });
});
