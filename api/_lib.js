// Shared utilities for AutoVal API endpoints.
// Leading underscore prevents Vercel treating this as a route.

// ---------------------------------------------------------------------------
// Supabase — comparable listings lookup
// ---------------------------------------------------------------------------

let _supabase;
function getSupabase() {
  if (!_supabase) {
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    // Always use the service role key for server-side operations — the anon key
    // is blocked by RLS policies for INSERT on the scans table.
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY not configured — Supabase disabled');
      return null;
    }
    _supabase = createClient(url, key);
    console.log('[supabase] Client initialised with service key — URL:', url.replace(/https?:\/\//, '').split('.')[0] + '.supabase.co');
  }
  return _supabase;
}

// ---------------------------------------------------------------------------
// Make / model normalisation
// ---------------------------------------------------------------------------

/**
 * Case-insensitive make pattern. ILIKE handles case, so just trim.
 * "Mercedes-Benz" stays "Mercedes-Benz" so ilike matches DB value exactly.
 */
function normaliseMake(make) {
  return make.trim();
}

/**
 * Builds an ILIKE pattern that matches common AU market model name variations:
 *   "RAV4"    → "rav%4"   matches "RAV4", "RAV 4", "RAV-4"
 *   "Mazda3"  → "mazda%3" matches "Mazda3", "Mazda 3"
 *   "C-Class" → "c%class" matches "C-Class", "C Class", "CClass"
 *   "HiLux"   → "hilux"   (no letter↔digit boundary — ILIKE handles case)
 * Strategy: strip spaces/hyphens, lowercase, then insert % at letter↔digit
 * boundaries so a single wildcard bridges both "word4" and "word 4" forms.
 */
function buildModelPattern(model) {
  const stripped = model.trim().toLowerCase().replace(/[\s\-]+/g, '');
  return stripped
    .replace(/([a-z])(\d)/g, '$1%$2')   // letter→digit: "rav4" → "rav%4"
    .replace(/(\d)([a-z])/g, '$1%$2');  // digit→letter: "3series" → "3%series"
}

/**
 * Returns comparable carsales.com.au listings for the vehicle.
 * Progressive fallback: state+tight mileage → national+tight → state+wide → national+wide → state only.
 * Minimum threshold: 5 listings before falling back to Claude estimate.
 * Returns { listings, isStateSpecific, isMileageFiltered, totalFound, source }
 */
async function getComparableListings(vehicle, userInputs) {
  const supabase = getSupabase();
  if (!supabase) {
    console.log('[comparables] Supabase not configured — skipping real listings query');
    return { listings: [], isStateSpecific: false, isMileageFiltered: false, totalFound: 0, source: 'no_data' };
  }

  const { make, model, yearLow, yearHigh } = vehicle;
  const { state, mileage, mileageUnknown } = userInputs;

  const makePattern  = normaliseMake(make);
  const modelPattern = buildModelPattern(model);
  const MIN_LISTINGS = 5;

  console.log(`[comparables] Query: make="${makePattern}" model="${model}" → pattern "${modelPattern}" year=${yearLow ?? '?'}-${yearHigh ?? '?'} state=${state ?? 'any'} mileage=${mileageUnknown ? 'unknown' : (mileage != null ? mileage.toLocaleString() + 'km' : 'null')} threshold=${MIN_LISTINGS}`);

  const yearFrom = (yearLow  ?? 2000) - 2;
  const yearTo   = (yearHigh ?? 2030) + 2;
  const tightLow  = mileageUnknown || mileage == null ? null : mileage - 30_000;
  const tightHigh = mileageUnknown || mileage == null ? null : mileage + 30_000;
  const wideLow   = mileageUnknown || mileage == null ? null : mileage - 50_000;
  const wideHigh  = mileageUnknown || mileage == null ? null : mileage + 50_000;

  const baseQuery = () => supabase
    .from('listings')
    .select('year, make, model, trim, odometer, price, state, colour, dealer_or_private, days_listed, scraped_at')
    .ilike('make', makePattern)
    .ilike('model', modelPattern)
    .gte('year', yearFrom)
    .lte('year', yearTo)
    .eq('is_active', true)
    .order('scraped_at', { ascending: false })
    .limit(20);

  const attempts = [
    { stateFilter: state, oLow: tightLow,  oHigh: tightHigh, isState: true,  isMileage: true,  label: 'state+tight-mileage' },
    { stateFilter: null,  oLow: tightLow,  oHigh: tightHigh, isState: false, isMileage: true,  label: 'national+tight-mileage' },
    { stateFilter: state, oLow: wideLow,   oHigh: wideHigh,  isState: true,  isMileage: true,  label: 'state+wide-mileage' },
    { stateFilter: null,  oLow: wideLow,   oHigh: wideHigh,  isState: false, isMileage: true,  label: 'national+wide-mileage' },
    { stateFilter: state, oLow: null,      oHigh: null,      isState: true,  isMileage: false, label: 'state+any-mileage' },
  ];

  for (const { stateFilter, oLow, oHigh, isState, isMileage, label } of attempts) {
    let q = baseQuery();
    if (stateFilter) q = q.eq('state', stateFilter);
    if (oLow  != null) q = q.gte('odometer', oLow);
    if (oHigh != null) q = q.lte('odometer', oHigh);

    const { data, error } = await q;
    if (error) {
      console.error(`[comparables] Supabase error on attempt "${label}":`, error.message);
      return { listings: [], isStateSpecific: false, isMileageFiltered: false, totalFound: 0, source: 'no_data' };
    }

    const count = data?.length ?? 0;
    console.log(`[comparables] Attempt "${label}": ${count} results`);

    if (count >= MIN_LISTINGS) {
      console.log(`[comparables] ✓ Threshold met (${count} >= ${MIN_LISTINGS}) — using real listings`);
      return { listings: data, isStateSpecific: isState, isMileageFiltered: isMileage, totalFound: count, source: 'real_listings' };
    }
  }

  console.log(`[comparables] ✗ All ${attempts.length} attempts exhausted with <${MIN_LISTINGS} listings — falling back to Claude estimate`);
  return { listings: [], isStateSpecific: false, isMileageFiltered: false, totalFound: 0, source: 'no_data' };
}

// ---------------------------------------------------------------------------
// App-secret auth check
// ---------------------------------------------------------------------------

/**
 * Returns true if the request carries the correct x-autoval-secret header.
 * When APP_SECRET env var is not set (local dev without .env.local) the
 * check is bypassed so development isn't blocked.
 */
function checkAppSecret(req, ip) {
  const APP_SECRET = process.env.APP_SECRET;
  if (!APP_SECRET) return true;                          // dev: not configured → allow
  const incoming = req.headers['x-autoval-secret'];
  if (incoming !== APP_SECRET) {
    console.warn(`[SECURITY] Invalid or missing app secret from IP ${ip} — header ${incoming ? '[present but wrong]' : '[missing]'}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rate limiter — multi-window, in-memory per serverless instance.
// For true global limits across cold-start instances use Upstash Redis.
// ---------------------------------------------------------------------------

const _rateLimitMap = new Map();

const RATE_LIMITS = {
  minute: 3,   // max scans per minute (nobody scans 3 cars per minute legitimately)
  hour:   20,  // max scans per hour
  day:    50,  // max scans per day
};

/**
 * Returns { allowed: true } or { allowed: false, retryAfter: seconds, window: string }.
 */
function checkRateLimit(ip) {
  const now        = Date.now();
  const ONE_MIN    = 60_000;
  const ONE_HOUR   = 3_600_000;
  const ONE_DAY    = 86_400_000;

  // Keep only timestamps within the largest window
  const times = (_rateLimitMap.get(ip) ?? []).filter(t => t > now - ONE_DAY);

  const perMin  = times.filter(t => t > now - ONE_MIN).length;
  const perHour = times.filter(t => t > now - ONE_HOUR).length;
  const perDay  = times.length;

  if (perMin >= RATE_LIMITS.minute) {
    const oldest = times.filter(t => t > now - ONE_MIN)[0];
    const retryAfter = Math.ceil((oldest + ONE_MIN - now) / 1000);
    console.warn(`[SECURITY] Rate limit (per-minute) hit for IP ${ip} — ${perMin} req/min`);
    return { allowed: false, retryAfter, window: 'minute' };
  }
  if (perHour >= RATE_LIMITS.hour) {
    const oldest = times.filter(t => t > now - ONE_HOUR)[0];
    const retryAfter = Math.ceil((oldest + ONE_HOUR - now) / 1000);
    console.warn(`[SECURITY] Rate limit (per-hour) hit for IP ${ip} — ${perHour} req/hour`);
    return { allowed: false, retryAfter, window: 'hour' };
  }
  if (perDay >= RATE_LIMITS.day) {
    const oldest = times[0];
    const retryAfter = Math.ceil((oldest + ONE_DAY - now) / 1000);
    console.warn(`[SECURITY] Rate limit (per-day) hit for IP ${ip} — ${perDay} req/day`);
    return { allowed: false, retryAfter, window: 'day' };
  }

  times.push(now);
  _rateLimitMap.set(ip, times);
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Response sanitisation — never leak internals to the client
// ---------------------------------------------------------------------------

// Error messages that are safe to forward verbatim to the client.
const SAFE_ERROR_PREFIXES = [
  'Anthropic ',
  'No text content',
  'images array',
  'each image',
  'maximum ',
  'image[',
  'vehicle ',
  'userInputs ',
  'make ',
  'model ',
  'year ',
  'state ',
  'postcode ',
  'mileage ',
  'askingPrice ',
  'Method not allowed',
  'vehicle object',
  'userInputs object',
];

function sanitiseError(err) {
  const msg = err?.message ?? 'Internal server error';
  // Forward only messages that are known-safe (validation / Anthropic errors)
  if (SAFE_ERROR_PREFIXES.some(p => msg.startsWith(p))) return msg;
  // All other internal errors (Supabase, network, etc.) get a generic message;
  // the full detail is already logged server-side via console.error.
  return 'Internal server error';
}

// ---------------------------------------------------------------------------
// Anthropic helper
// ---------------------------------------------------------------------------

async function callAnthropic(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ANTHROPIC_API_KEY not configured'), { status: 500 });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const status = response.status;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const msg = `Anthropic ${status}${text ? ' — ' + text.slice(0, 200) : ''}`;
    throw Object.assign(new Error(msg), { status });
  }

  const data = await response.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock) throw Object.assign(new Error('No text content in Anthropic response'), { status: 502 });

  return stripFences(textBlock.text);
}

function stripFences(text) {
  const t = text.trim();
  if (!t.startsWith('```')) return t;
  const lines = t.split('\n');
  lines.shift();
  if (lines.at(-1)?.trim() === '```') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 1 system prompt
// ---------------------------------------------------------------------------

const PHASE1_SYSTEM_PROMPT = `You are an expert automotive computer-vision system specialising in the Australian vehicle market.

The user will send one or more photos of a vehicle. Analyse every photo carefully and return ONLY a single raw JSON object — no markdown, no explanation, no extra text.

Required JSON schema:
{
  "make": "string — manufacturer name, e.g. Toyota",
  "model": "string — model name, e.g. RAV4",
  "yearLow": integer — earliest plausible model year,
  "yearHigh": integer — latest plausible model year,
  "bodyType": "Sedan|Hatchback|SUV|Wagon|Ute|Van|Coupe|Convertible|People Mover",
  "trim": "string — trim/variant if identifiable, else empty string",
  "colour": "string — exterior colour",
  "driveType": "FWD|AWD|4WD|RWD|unknown",
  "cvConfidence": integer 40–98 — your overall identification confidence,
  "conditionSignals": {
    "paint": "Good|Fair|Poor",
    "panelWork": "No visible damage|Minor marks|Moderate damage|Significant damage",
    "tyres": "Good|Worn|Unknown",
    "overall": "Excellent|Very Good|Good|Fair|Poor"
  },
  "identificationNotes": "string — one or two sentences noting key identifying features or uncertainty",
  "detectedFeatures": ["array", "of", "notable", "features"],
  "photoCount": integer — number of photos analysed
}

Rules:
- Return ONLY the JSON object. No markdown fences, no preamble.
- If you cannot identify the vehicle reliably, still return your best guess with a low cvConfidence.
- Do not include the licence plate in any field.
- yearLow and yearHigh define the production generation visible, not a single year.`;

function buildPhase1UserPrompt(photoCount) {
  const ref = photoCount === 1 ? 'this photo' : `these ${photoCount} photos`;
  return `Please identify the vehicle in ${ref} and return the JSON as specified. Focus on bodywork condition, trim badges, and any distinguishing features visible from the Australian market perspective.`;
}

// ---------------------------------------------------------------------------
// Phase 2 system prompt
// ---------------------------------------------------------------------------

const PHASE2_SYSTEM_PROMPT = `You are an expert Australian used-vehicle market pricing analyst.

The user will provide confirmed vehicle details. Your job is to produce a conservative, realistic transaction-price valuation for the current Australian used-car market.

IMPORTANT CALIBRATION — Australian used car market reality:
- Listing prices on carsales.com.au are typically 8-15% above actual transaction prices due to negotiation
- Your valuations must reflect TRANSACTION values, not listing prices
- Apply a market reality discount of approximately 10-12% to any comparable listing prices you reference
- Private sales typically achieve 5-8% less than dealer asking prices
- The Australian used car market has softened significantly since the 2021-2022 peak — prices have come down 10-20% from those highs
- Be conservative rather than optimistic — it is better to slightly undervalue than overvalue, as users will lose trust if they cannot achieve the stated price

Calibration examples (listing price → typical transaction price):
- Listed at $30,000 on carsales → transacts at $26,500–$28,000
- Listed at $50,000 on carsales → transacts at $44,000–$47,000
- High-demand models (HiLux, RAV4, Ranger) have a smaller list-to-transaction gap due to buyer competition
- Dealer prices carry a larger premium than private sale prices

Return ONLY a single raw JSON object — no markdown, no explanation, no extra text.

Required JSON schema:
{
  "comparables": {
    "totalFound": integer — realistic number of comparable AU listings,
    "afterOutlierRemoval": integer — listings remaining after 1.5x IQR filter,
    "medianDaysOnMarket": integer — typical days on market for this vehicle,
    "priceReductionRate": "string — e.g. '22% of listings'",
    "regionalDemandIndex": "Low|Moderate|High|Very High",
    "marketVelocity": "Slow|Moderate|Fast|Very Fast"
  },
  "baseValuation": { "low": integer AUD, "mid": integer AUD, "high": integer AUD },
  "adjustments": [
    {
      "factor": "string — adjustment name",
      "impact": integer AUD (positive or negative),
      "direction": "positive|negative|neutral",
      "explanation": "string — one sentence"
    }
  ],
  "finalValuation": { "low": integer AUD, "mid": integer AUD, "high": integer AUD },
  "confidenceScore": integer 0–100,
  "confidenceFactors": ["array of strings explaining confidence"],
  "pricingDrivers": ["array of key factors driving this vehicle's value"],
  "marketInsight": "string — 1–2 sentences of market commentary for this vehicle"
}

Rules:
- Return ONLY the JSON object. No markdown fences.
- All prices in AUD, representing realistic TRANSACTION prices for the current Australian used-car market.
- Use the median comparable as the base mid estimate, THEN apply a 10% market reality adjustment downward to convert listing prices to realistic transaction prices. The mid value should represent what a buyer would realistically pay, not what a seller hopes to achieve.
- finalValuation must incorporate all adjustments applied to baseValuation.mid.
- Provide 3–6 adjustments — include condition, colour, regional demand, and any notable features.
- The low-mid-high range should typically span no more than 15-20% total (e.g. Low: $26,000 / Mid: $28,500 / High: $31,000 — NOT Low: $22,000 / Mid: $30,000 / High: $38,000). A tight range is more useful.
- If your valuation is based on listing prices rather than confirmed transaction data, include in confidenceFactors: "Values adjusted from listing prices to estimated transaction prices"
- If mileage is unknown, do NOT apply a mileage adjustment; instead note the missing odometer in confidenceFactors and use a reduced confidenceScore.`;

function buildPhase2UserPrompt(vehicle, inputs, comparables = []) {
  const odometer = inputs.mileageUnknown
    ? 'Unknown — use fleet average for age and type. Do NOT apply a mileage adjustment.'
    : inputs.mileage != null
      ? `${inputs.mileage.toLocaleString()} km`
      : 'Unknown';

  const features = vehicle.detectedFeatures?.length
    ? vehicle.detectedFeatures.join(', ')
    : 'None detected';

  let comparablesSection;
  if (comparables.length >= 1) {
    const lines = comparables.map(c => {
      const odo = c.odometer ? `${c.odometer.toLocaleString()}km` : 'odo unknown';
      const seller = c.dealer_or_private ? ` (${c.dealer_or_private})` : '';
      return `- ${c.year} ${c.make} ${c.model}${c.trim ? ' ' + c.trim : ''}, ${odo}, ${c.state ?? '?'}${seller} — $${c.price.toLocaleString()}`;
    }).join('\n');

    comparablesSection = `\nREAL COMPARABLE LISTINGS FROM CARSALES.COM.AU (ASKING PRICES):\n${lines}\n\nIMPORTANT: These are ASKING PRICES, not transaction prices. Apply a 10% reduction to convert to realistic transaction prices before calculating your valuation range. Calculate the median asking price, remove outliers beyond 1.5× IQR, then apply the 10% listing-to-transaction discount to set your baseValuation. Set comparables.totalFound and comparables.afterOutlierRemoval based on this data.`;
  } else {
    comparablesSection = '\nNote: No live AutoTrader AU listings found for this specification. Base your valuation on estimated market data and note "Based on estimated market data — no live listings found for this specification" in confidenceFactors. Use a reduced confidenceScore.';
  }

  const isDeal = inputs.scanMode === 'deal' && inputs.askingPrice > 0;

  const dealSection = isDeal ? `

DEAL CHECK MODE — ASKING PRICE: $${inputs.askingPrice.toLocaleString()} AUD
The buyer is considering purchasing this vehicle at the asking price above.
After completing the standard valuation JSON, append a "dealAnalysis" object with this exact schema:
{
  "dealAnalysis": {
    "verdict": "overpriced" | "fair" | "good_deal" | "excellent_deal",
    "summary": "string — one sentence summarising the deal quality",
    "negotiationTip": "string — one actionable sentence of negotiation advice",
    "suggestedOffer": { "low": integer AUD, "high": integer AUD }
  }
}
Verdict rules (based on asking vs your finalValuation.mid):
- asking > mid by more than 10% → "overpriced"
- asking within +10% / -5% of mid → "fair"
- asking below mid by 5–15% → "good_deal"
- asking below mid by more than 15% → "excellent_deal"
suggestedOffer.low = mid * 0.90, suggestedOffer.high = mid * 0.97 (always use market mid, not asking price).` : '';

  const additionalDetailsSection = inputs.additionalDetails
    ? `\n\nADDITIONAL DETAILS PROVIDED BY OWNER:\n${inputs.additionalDetails}\n\nFactor these details into your valuation:\n- Custom fitouts (canopies, bullbars, tow bars) typically add $500–$3,000 depending on quality\n- Performance modifications can add or subtract value depending on type\n- Recent service history adds confidence\n- New tyres typically add $400–$800\n- Upgraded audio/tech adds $200–$800\n- Custom interiors vary widely\n- Damage or issues should reduce the valuation accordingly\nIf the owner mentions significant extras, note them in pricingDrivers and explain the impact in marketInsight.`
    : '';

  return `Please provide a market valuation for the following Australian vehicle:

Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim ?? ''}
Body type: ${vehicle.bodyType}
Colour: ${vehicle.colour}
Drive type: ${vehicle.driveType}

Owner details:
Odometer: ${odometer}
Owner-reported condition: ${inputs.condition}
State: ${inputs.state}
Postcode: ${(inputs.postcodeUnknown || !inputs.postcode || inputs.postcode.trim() === '') ? `Unknown — use state average pricing for ${inputs.state}` : inputs.postcode}

AI-assessed condition:
Paint: ${vehicle.conditionSignals?.paint}
Panel work: ${vehicle.conditionSignals?.panelWork}
Tyres: ${vehicle.conditionSignals?.tyres}
Overall: ${vehicle.conditionSignals?.overall}

Detected features: ${features}
CV identification confidence: ${vehicle.cvConfidence}%
${comparablesSection}${additionalDetailsSection}${dealSection}

Return the valuation JSON as specified in the system prompt.`;
}

// ---------------------------------------------------------------------------
// Garage revaluation prompt (text-only, no photos)
// ---------------------------------------------------------------------------

function buildRevalueUserPrompt(car, comparables = []) {
  const year = parseInt(car.year) || new Date().getFullYear() - 5;
  const ageYears = Math.max(1, new Date().getFullYear() - year);
  const estimatedOdo = (ageYears * 15_000).toLocaleString();

  let comparablesSection;
  if (comparables.length >= 1) {
    const lines = comparables.map(c => {
      const odo = c.odometer ? `${c.odometer.toLocaleString()}km` : 'odo unknown';
      const seller = c.dealer_or_private ? ` (${c.dealer_or_private})` : '';
      return `- ${c.year} ${c.make} ${c.model}${c.trim ? ' ' + c.trim : ''}, ${odo}, ${c.state ?? '?'}${seller} — $${c.price.toLocaleString()}`;
    }).join('\n');
    comparablesSection = `\nREAL COMPARABLE LISTINGS FROM CARSALES.COM.AU (ASKING PRICES):\n${lines}\n\nIMPORTANT: These are ASKING PRICES. Apply a 10% reduction for realistic transaction prices.`;
  } else {
    comparablesSection = '\nNote: No live comparable listings found. Base valuation on estimated market data.';
  }

  return `Please provide a current market valuation for this Australian vehicle (automatic garage revaluation — no photos available):

Vehicle: ${car.year} ${car.make} ${car.model}${car.trim ? ' ' + car.trim : ''}
Body type: ${car.bodyType || 'unknown'}
State: ${car.state || 'NSW'}

Note: This is an automatic revaluation — no odometer or condition data is available.
Estimated odometer based on age (~15,000 km/year): approximately ${estimatedOdo} km (${ageYears} year${ageYears === 1 ? '' : 's'} old).
Assume average condition for age and type.
${comparablesSection}

Return the valuation JSON as specified in the system prompt.`;
}

// ---------------------------------------------------------------------------
// Market average — median valuation_mid from scans table for this vehicle
// ---------------------------------------------------------------------------

async function getMarketAverage(make, model, year) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('scans')
    .select('valuation_mid')
    .ilike('make', normaliseMake(make))
    .ilike('model', buildModelPattern(model))
    .gte('year', year - 1)
    .lte('year', year + 1)
    .not('valuation_mid', 'is', null)
    .limit(100);

  if (error || !data || data.length < 3) return null;

  const sorted = data.map(r => r.valuation_mid).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]; // median
}

// ---------------------------------------------------------------------------
// Scan analytics persistence
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: saves an anonymous scan record to the scans table.
 * Never throws — a save failure must not affect the user's response.
 * isGarageRevaluation = true when called from /api/revalue-garage.
 */
async function saveScan(vehicle, userInputs, pricingResult, comparableMeta, isGarageRevaluation = false) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      console.warn('[saveScan] Supabase not available — skipping save');
      return;
    }

    console.log(`[saveScan] Inserting scan: ${vehicle.year} ${vehicle.make} ${vehicle.model} mid=$${pricingResult.finalValuation?.mid}`);

    const validUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawUserId = userInputs.userId ?? null;
    const safeUserId = rawUserId && validUUID.test(rawUserId) ? rawUserId : null;

    const { error } = await supabase.from('scans').insert({
      make:                 vehicle.make,
      model:                vehicle.model,
      year:                 vehicle.year != null ? parseInt(vehicle.year, 10) : null,
      trim:                 vehicle.trim,
      body_type:            vehicle.bodyType,
      colour:               vehicle.colour,
      drive_type:           vehicle.driveType,
      cv_confidence:        vehicle.cvConfidence,
      paint_condition:      vehicle.conditionSignals?.paint,
      panel_condition:      vehicle.conditionSignals?.panelWork,
      overall_condition:    vehicle.conditionSignals?.overall,
      odometer:             userInputs.mileageUnknown ? null : userInputs.mileage,
      mileage_unknown:      userInputs.mileageUnknown ?? false,
      user_condition:       userInputs.condition,
      state:                userInputs.state,
      postcode:             userInputs.postcode,
      valuation_low:        pricingResult.finalValuation?.low,
      valuation_mid:        pricingResult.finalValuation?.mid,
      valuation_high:       pricingResult.finalValuation?.high,
      confidence_score:     pricingResult.confidenceScore,
      market_insight:       pricingResult.marketInsight,
      comparables_found:    pricingResult.comparables?.totalFound,
      regional_demand:      pricingResult.comparables?.regionalDemandIndex,
      market_velocity:      pricingResult.comparables?.marketVelocity,
      used_real_listings:      comparableMeta?.source === 'real_listings',
      real_listings_count:     comparableMeta?.totalFound ?? 0,
      is_garage_revaluation:   isGarageRevaluation,
      additional_details:      userInputs.additionalDetails ?? null,
      user_id:                 safeUserId,
      scan_mode:               userInputs.scanMode ?? 'valuation',
      app_version:             '1.0',
    });

    if (error) {
      console.error('[saveScan] INSERT FAILED — code:', error.code, '| message:', error.message, '| details:', error.details, '| hint:', error.hint);
    } else {
      console.log(`[saveScan] INSERT SUCCESS: ${vehicle.year} ${vehicle.make} ${vehicle.model} $${pricingResult.finalValuation?.mid}`);
    }
  } catch (err) {
    console.error('[saveScan] unexpected error:', err.message);
  }
}

module.exports = {
  checkAppSecret,
  checkRateLimit,
  callAnthropic,
  getComparableListings,
  getMarketAverage,
  saveScan,
  sanitiseError,
  PHASE1_SYSTEM_PROMPT,
  buildPhase1UserPrompt,
  PHASE2_SYSTEM_PROMPT,
  buildPhase2UserPrompt,
  buildRevalueUserPrompt,
};
