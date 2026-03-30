const { checkRateLimit, callAnthropic, getComparableListings, saveScan, PHASE2_SYSTEM_PROMPT, buildPhase2UserPrompt } = require('./_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests — please wait a moment' });
  }

  // Validate body
  const { vehicle, userInputs } = req.body ?? {};
  if (!vehicle || typeof vehicle !== 'object') {
    return res.status(400).json({ error: 'vehicle object is required' });
  }
  if (!userInputs || typeof userInputs !== 'object') {
    return res.status(400).json({ error: 'userInputs object is required' });
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
    if (!userInputs.analyticsOptOut) {
      console.log(`[value] ▶ Step 6 — Saving scan to Supabase analytics...`);
      saveScan(vehicle, userInputs, parsed, comparableMeta);
    } else {
      console.log(`[value] ▶ Step 6 — Analytics save skipped (user opted out)`);
    }

    // ── Step 7: Return result ─────────────────────────────────────────────────
    console.log(`[value] ▶ Step 7 — Complete — returning result to iOS app (source=${source} listings=${totalFound})`);

    return res.status(200).json({
      ...parsed,
      dataSource:            source,
      realListingsUsed:      totalFound,
      listingsStateSpecific: isStateSpecific,
      scrapedAt,
    });
  } catch (err) {
    console.error(`[value] ✗ Error: ${err.message}`);
    return res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
  }
};
