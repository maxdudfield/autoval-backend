// POST /api/feedback/submit
// Records a user's post-sale outcome for a previous valuation scan.
//
// Body: {
//   scan_id:           string (UUID) — the Supabase scan UUID
//   user_id:           string        — the authenticated user's ID
//   outcome:           string        — 'sold' | 'still_listed' | 'kept' | 'declined_to_say'
//   actual_sale_price: integer|null  — what they got (only for 'sold')
//   days_to_sell:      integer|null  — days from scan to sale
// }
//
// Auth: x-autoval-secret header.

const { checkAppSecret, sanitiseError } = require('../_lib');
const { withErrorReporting } = require('../_lib/errorReporter');

const VALID_OUTCOMES = new Set(['sold', 'still_listed', 'kept', 'declined_to_say']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = withErrorReporting(async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const { scan_id, user_id, outcome, actual_sale_price, days_to_sell } = req.body ?? {};

  // Validation
  if (!scan_id || typeof scan_id !== 'string' || !UUID_RE.test(scan_id)) {
    return res.status(400).json({ error: 'scan_id must be a valid UUID' });
  }
  if (!user_id || typeof user_id !== 'string' || !UUID_RE.test(user_id)) {
    return res.status(400).json({ error: 'user_id must be a valid UUID' });
  }
  if (!outcome || !VALID_OUTCOMES.has(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${[...VALID_OUTCOMES].join(', ')}` });
  }
  if (actual_sale_price != null) {
    const p = Number(actual_sale_price);
    if (!Number.isInteger(p) || p < 100 || p > 10_000_000) {
      return res.status(400).json({ error: 'actual_sale_price must be between 100 and 10,000,000' });
    }
  }
  if (days_to_sell != null) {
    const d = Number(days_to_sell);
    if (!Number.isInteger(d) || d < 0 || d > 3650) {
      return res.status(400).json({ error: 'days_to_sell must be between 0 and 3650' });
    }
  }

  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const supabase = createClient(url, key);

  try {
    // Find or create the scan_outcomes row for this scan
    const { data: existingRow, error: findError } = await supabase
      .from('scan_outcomes')
      .select('id, user_id, our_valuation_mid')
      .eq('scan_id', scan_id)
      .maybeSingle();

    if (findError) {
      console.error('[feedback/submit] find error:', findError.message);
      return res.status(500).json({ error: sanitiseError(findError) });
    }

    // #4: verify ownership even when a pending row already exists
    if (existingRow && existingRow.user_id !== user_id) {
      return res.status(403).json({ error: 'Scan not found or not owned by this user' });
    }

    // If no pending row exists (user responded without receiving a prompt),
    // look up our_valuation_mid from the scans table to populate it.
    let ourValuationMid = existingRow?.our_valuation_mid ?? null;
    if (!existingRow) {
      const { data: scanRow, error: scanError } = await supabase
        .from('scans')
        .select('valuation_mid, user_id')
        .eq('id', scan_id)
        .single();

      if (scanError) {
        console.error('[feedback/submit] scan lookup error:', scanError.message);
        return res.status(500).json({ error: sanitiseError(scanError) });
      }

      // Security: ensure the submitting user owns this scan
      if (!scanRow || scanRow.user_id !== user_id) {
        return res.status(403).json({ error: 'Scan not found or not owned by this user' });
      }
      ourValuationMid = scanRow.valuation_mid;
    }

    // Calculate variance
    let variancePct = null;
    if (actual_sale_price != null && ourValuationMid != null && ourValuationMid > 0) {
      variancePct = parseFloat(
        (((actual_sale_price - ourValuationMid) / ourValuationMid) * 100).toFixed(2)
      );
    }

    const respondedAt = new Date().toISOString();
    const updatePayload = {
      responded_at:      respondedAt,
      outcome,
      actual_sale_price: actual_sale_price ?? null,
      our_valuation_mid: ourValuationMid,
      variance_pct:      variancePct,
      days_to_sell:      days_to_sell ?? null,
    };

    let upsertError;
    if (existingRow) {
      // Update the pending row
      const { error } = await supabase
        .from('scan_outcomes')
        .update(updatePayload)
        .eq('id', existingRow.id);
      upsertError = error;
    } else {
      // Create a new row (user responded proactively, no prompt was sent)
      const { error } = await supabase
        .from('scan_outcomes')
        .insert({ scan_id, user_id, ...updatePayload, prompted_at: respondedAt });
      upsertError = error;
    }

    if (upsertError) {
      console.error('[feedback/submit] upsert error:', upsertError.message);
      return res.status(500).json({ error: sanitiseError(upsertError) });
    }

    // Count total responses from this user (their data contribution score)
    const { count, error: countError } = await supabase
      .from('scan_outcomes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .not('responded_at', 'is', null);

    if (countError) {
      console.error('[feedback/submit] count error:', countError.message);
    }
    const contributions = count ?? 1;

    console.log(`[feedback/submit] outcome="${outcome}" variance=${variancePct != null ? variancePct + '%' : 'n/a'} user=${user_id.slice(0, 8)}… contributions=${contributions}`);

    const thankYou = outcome === 'sold'
      ? actual_sale_price
        ? `Thanks for sharing! Your real sale price helps us calibrate for ${new Date().getFullYear()} vehicles.`
        : `Thanks for letting us know you sold it!`
      : outcome === 'kept'
        ? `Good choice! Thanks for the update.`
        : `Thanks for the update — we'll check back later.`;

    return res.status(200).json({
      success: true,
      message: thankYou,
      contributions,
      variancePct,
    });

  } catch (err) {
    console.error('[feedback/submit] unexpected error:', err.message);
    return res.status(500).json({ error: sanitiseError(err) });
  }
});
