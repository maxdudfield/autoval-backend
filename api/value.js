const { checkAppSecret, checkRateLimit, callAnthropic, getComparableListings, saveScan, sanitiseError, PHASE2_SYSTEM_PROMPT, buildPhase2UserPrompt } = require('./_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);
const CURRENT_YEAR = new Date().getFullYear();

function validateRequest(vehicle, userInputs) {
  if (!vehicle || typeof vehicle !== 'object')
    return 'vehicle object is required';
  if (!vehicle.make || typeof vehicle.make !== 'string' || vehicle.make.trim().length === 0)
    return 'vehicle.make must be a non-empty string';
  if (!vehicle.model || typeof vehicle.model !== 'string' || vehicle.model.trim().length === 0)
    return 'vehicle.model must be a non-empty string';

  // Year validation — accept any of year / yearLow / yearHigh
  const year = vehicle.year ?? vehicle.yearLow ?? vehicle.yearHigh;
  if (year != null) {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 1990 || y > CURRENT_YEAR + 1)
      return `year must be between 1990 and ${CURRENT_YEAR + 1}`;
  }

  if (!userInputs || typeof userInputs !== 'object')
    return 'userInputs object is required';
  if (!AU_STATES.has(userInputs.state))
    return `state must be one of: ${[...AU_STATES].join(', ')}`;
  // Postcode is optional — skip validation when unknown or blank
  if (!userInputs.postcodeUnknown && userInputs.postcode && userInputs.postcode.trim() !== '') {
    if (!/^\d{4}$/.test(userInputs.postcode.trim()))
      return 'postcode must be exactly 4 digits';
  }

  if (!userInputs.mileageUnknown && userInputs.mileage != null) {
    const m = Number(userInputs.mileage);
    if (!Number.isInteger(m) || m < 0 || m > 999_999)
      return 'mileage must be between 0 and 999999';
  }

  if (userInputs.askingPrice != null) {
    const p = Number(userInputs.askingPrice);
    if (!Number.isInteger(p) || p < 100 || p > 10_000_000)
      return 'askingPrice must be between 100 and 10000000';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!checkAppSecret(req, ip)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: rateCheck.retryAfter,
      message: 'Please wait before scanning again',
    });
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const { vehicle, userInputs } = req.body ?? {};
  const validationError = validateRequest(vehicle, userInputs);
  if (validationError) {
    console.warn(`[SECURITY] Invalid request body from IP ${ip}: ${validationError}`);
    return res.status(400).json({ error: validationError });
  }

  const vehicleLabel = `${vehicle.yearLow ?? vehicle.year ?? '?'} ${vehicle.make} ${vehicle.model}`;
  const isDeal = userInputs.scanMode === 'deal' && userInputs.askingPrice > 0;

  // ── Step 1: Request received ─────────────────────────────────────────────
  console.log(`[value] ▶ Step 1 — Request received: ${vehicleLabel} state=${userInputs.state ?? '?'} mode=${userInputs.scanMode ?? 'valuation'}${isDeal ? ` askingPrice=$${userInputs.askingPrice.toLocaleString()}` : ''}`);

  // ── Step 2: Query Supabase BEFORE calling Claude ─────────────────────────
  console.log(`[value] ▶ Step 2 — Querying Supabase for real listings...`);
  let comparableMeta;
  try {
    comparableMeta = await getComparableListings(vehicle, userInputs);
  } catch (err) {
    console.error('[value] Comparables fetch failed, using fallback:', err.message);
    comparableMeta = { listings: [], isStateSpecific: false, isMileageFiltered: false, totalFound: 0, source: 'no_data' };
  }

  const { listings, isStateSpecific, isMileageFiltered, totalFound, source } = comparableMeta;
  const scrapedAt = listings.length > 0 ? (listings[0].scraped_at ?? null) : null;

  console.log(`[value] ▶ Step 2 — Found ${totalFound} listings in Supabase for ${vehicle.make} ${vehicle.model} (stateSpecific=${isStateSpecific} mileageFiltered=${isMileageFiltered})`);

  // ── Step 3 / 4: Build prompt (with or without real listings) ─────────────
  const stepLabel = source === 'real_listings'
    ? `Step 3 — Injecting ${totalFound} real listings into Claude prompt`
    : `Step 4 — No real listings found — using Claude estimate prompt`;
  console.log(`[value] ▶ ${stepLabel}`);

  const userPrompt = buildPhase2UserPrompt(vehicle, userInputs, listings);
  console.log(`[value] Claude prompt preview: ${userPrompt.substring(0, 500)}...`);

  const anthropicBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: isDeal ? 1800 : 1500,
    system: PHASE2_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  };

  // ── Step 5: Call Claude API ───────────────────────────────────────────────
  console.log(`[value] ▶ Step 5 — Calling Claude API (max_tokens=${anthropicBody.max_tokens} source=${source})...`);

  try {
    const jsonText = await callAnthropic(anthropicBody);
    const parsed = JSON.parse(jsonText);

    console.log(`[value] ▶ Step 5 — Claude responded — valuation mid: $${parsed.finalValuation?.mid?.toLocaleString() ?? 'n/a'} confidence: ${parsed.confidenceScore ?? 'n/a'}%`);

    // ── Step 6: Save scan analytics ──────────────────────────────────────────
    let scanId = null;
    if (!userInputs.analyticsOptOut) {
      console.log(`[value] ▶ Step 6 — Saving scan to Supabase analytics...`);
      scanId = await saveScan(vehicle, userInputs, parsed, comparableMeta);
    } else {
      console.log(`[value] ▶ Step 6 — Analytics save skipped (user opted out)`);
    }

    // ── Step 7: Return result ─────────────────────────────────────────────────
    console.log(`[value] ▶ Step 7 — Complete — returning result to iOS app (source=${source} listings=${totalFound} scanId=${scanId ?? 'none'})`);

    return res.status(200).json({
      ...parsed,
      scanId,                             // Supabase UUID — stored in iOS for feedback linkage
      dataSource:            source,
      realListingsUsed:      totalFound,
      listingsStateSpecific: isStateSpecific,
      scrapedAt,
    });
  } catch (err) {
    console.error(`[value] ✗ Error: ${err.message}`);
    return res.status(err.status ?? 500).json({ error: sanitiseError(err) });
  }
};
