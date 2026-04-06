// POST /api/events
// Batch insert behavioural events for market analytics.
// Fire-and-forget — never blocks the user's scan flow.

const { checkAppSecret, sanitiseError } = require('./_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '100kb' } },
};

const MAX_BATCH = 50;
const VALID_EVENT_TYPES = new Set([
  // Scan lifecycle
  'scan_started', 'scan_mode_selected', 'scan_photo_taken',
  'scan_completed', 'scan_saved', 'scan_failed',
  // Deal finder (highest value)
  'deal_finder_opened', 'deal_search_intent', 'deal_search_started',
  'deal_photo_taken', 'deal_price_entered', 'deal_completed', 'deal_saved',
  // Garage
  'garage_car_added', 'garage_car_revalued', 'garage_car_removed', 'garage_alert_toggled',
  // Confirm screen corrections
  'vehicle_correction',
  // Paywall funnel
  'paywall_shown', 'paywall_dismissed', 'paywall_converted',
  // Navigation
  'tab_changed', 'screen_viewed',
  // Session
  'app_opened', 'app_backgrounded', 'signed_out',
]);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const { events } = req.body ?? {};
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events array required' });
  }

  const batch = events
    .slice(0, MAX_BATCH)
    .map(e => {
      const eventType = String(e.eventType ?? e.event_type ?? '').slice(0, 64);
      if (!VALID_EVENT_TYPES.has(eventType)) return null;
      return {
        event_type:      eventType,
        occurred_at:     e.occurredAt ?? e.occurred_at ?? new Date().toISOString(),
        session_id:      e.sessionId ?? e.session_id ?? null,
        user_id:         e.userId ?? e.user_id ?? null,
        make:            e.make ?? null,
        model:           e.model ?? null,
        year:            e.year ? parseInt(e.year) : null,
        state:           e.state ?? null,
        asking_price:    e.askingPrice ?? e.asking_price ?? null,
        valuation_mid:   e.valuationMid ?? e.valuation_mid ?? null,
        deal_verdict:    e.dealVerdict ?? e.deal_verdict ?? null,
        screen:          e.screen ?? null,
        additional_data: e.additionalData ?? e.additional_data ?? {},
      };
    })
    .filter(Boolean);

  if (batch.length === 0) {
    return res.status(200).json({ success: true, count: 0 });
  }

  // Gracefully handle missing Supabase config — don't fail clients
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL) {
    return res.status(200).json({ success: true, count: 0, note: 'Supabase not configured' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  const { error } = await supabase.from('events').insert(batch);
  if (error) {
    console.error('[events] insert error:', error.message);
    // Still return 200 — analytics failure must never affect the user
    return res.status(200).json({ success: false, note: error.message });
  }

  console.log(`[events] ✓ recorded ${batch.length} event(s): ${[...new Set(batch.map(e => e.event_type))].join(', ')}`);
  return res.status(200).json({ success: true, count: batch.length });
};
