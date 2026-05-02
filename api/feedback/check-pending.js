// POST /api/feedback/check-pending
// Called daily by GitHub Actions.
//
// Finds seller scans (scan_mode = 'valuation') created 25–35 days ago whose
// user_id is set and that have no row yet in scan_outcomes. Inserts a pending
// row (prompted_at = now) for each, then returns the list so a notification
// layer (APNS — future) can push to those users.
//
// Auth: x-autoval-secret header (APP_SECRET env var).

const { checkAppSecret, sanitiseError } = require('../_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('[feedback/check-pending] SUPABASE_URL or SUPABASE_SERVICE_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const supabase = createClient(url, key);

  try {
    const now = new Date();
    const cutoffOld = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString(); // 35 days ago
    const cutoffNew = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString(); // 25 days ago

    console.log(`[feedback/check-pending] Looking for scans between ${cutoffOld} and ${cutoffNew}`);

    // Find valuation scans from 25–35 days ago that have a user_id
    const { data: candidateScans, error: scansError } = await supabase
      .from('scans')
      .select('id, user_id, make, model, year, valuation_mid, scanned_at')
      .eq('scan_mode', 'valuation')
      .not('user_id', 'is', null)
      .not('valuation_mid', 'is', null)
      .gte('scanned_at', cutoffOld)
      .lte('scanned_at', cutoffNew)
      .order('scanned_at', { ascending: false });

    if (scansError) {
      console.error('[feedback/check-pending] scans query error:', scansError.message);
      return res.status(500).json({ error: sanitiseError(scansError) });
    }

    if (!candidateScans || candidateScans.length === 0) {
      console.log('[feedback/check-pending] No candidate scans in window');
      return res.status(200).json({ inserted: 0, pending: [] });
    }

    console.log(`[feedback/check-pending] ${candidateScans.length} candidate scan(s) in window`);

    // Filter out scans that already have a scan_outcomes row
    const candidateIds = candidateScans.map(s => s.id);
    const { data: existingOutcomes, error: outcomesError } = await supabase
      .from('scan_outcomes')
      .select('scan_id')
      .in('scan_id', candidateIds);

    if (outcomesError) {
      console.error('[feedback/check-pending] scan_outcomes query error:', outcomesError.message);
      return res.status(500).json({ error: sanitiseError(outcomesError) });
    }

    const alreadyPrompted = new Set((existingOutcomes ?? []).map(o => o.scan_id));
    const newScans = candidateScans.filter(s => !alreadyPrompted.has(s.id));

    console.log(`[feedback/check-pending] ${newScans.length} new scan(s) need prompting (${alreadyPrompted.size} already have rows)`);

    if (newScans.length === 0) {
      return res.status(200).json({ inserted: 0, pending: [] });
    }

    // Insert pending rows
    const pendingRows = newScans.map(s => ({
      scan_id:           s.id,
      user_id:           s.user_id,
      our_valuation_mid: s.valuation_mid,
      prompted_at:       now.toISOString(),
    }));

    const { error: insertError } = await supabase
      .from('scan_outcomes')
      .insert(pendingRows);

    if (insertError) {
      console.error('[feedback/check-pending] insert error:', insertError.message);
      return res.status(500).json({ error: sanitiseError(insertError) });
    }

    // Build the notification list (APNS delivery — future implementation)
    const pending = newScans.map(s => ({
      scan_id:  s.id,
      user_id:  s.user_id,
      make:     s.make,
      model:    s.model,
      year:     s.year,
    }));

    // Log: who would be notified
    console.log('[feedback/check-pending] Would notify the following users (APNS not yet wired):');
    pending.forEach(p => {
      console.log(`  user=${p.user_id?.slice(0, 8)}… scan=${p.scan_id?.slice(0, 8)}… — ${p.year} ${p.make} ${p.model}`);
    });

    console.log(`[feedback/check-pending] Done — inserted ${newScans.length} pending row(s)`);

    return res.status(200).json({
      inserted: newScans.length,
      pending,
    });

  } catch (err) {
    console.error('[feedback/check-pending] unexpected error:', err.message);
    return res.status(500).json({ error: sanitiseError(err) });
  }
};
