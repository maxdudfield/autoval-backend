// POST /api/revalue-garage
// Text-only valuation for a garage car — no photos required.
// Called by the iOS app on a schedule (30-day auto) or manual refresh.

const {
  checkAppSecret, checkRateLimit, callAnthropic,
  getComparableListings, getMarketAverage, saveScan,
  sanitiseError, PHASE2_SYSTEM_PROMPT, buildRevalueUserPrompt,
} = require('./_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '100kb' } },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);
const CURRENT_YEAR = new Date().getFullYear();

function validateCar(car) {
  if (!car || typeof car !== 'object') return 'car object is required';
  if (!car.make || typeof car.make !== 'string' || !car.make.trim()) return 'car.make is required';
  if (!car.model || typeof car.model !== 'string' || !car.model.trim()) return 'car.model is required';
  if (car.year != null) {
    const y = Number(car.year);
    if (!Number.isInteger(y) || y < 1990 || y > CURRENT_YEAR + 1)
      return `car.year must be between 1990 and ${CURRENT_YEAR + 1}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';

  // Auth + rate limit
  if (!checkAppSecret(req, ip)) return res.status(401).json({ error: 'Unauthorised' });
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter });
  }

  // Validate
  const { car } = req.body ?? {};
  const validationError = validateCar(car);
  if (validationError) return res.status(400).json({ error: validationError });

  const yearNum = parseInt(car.year) || CURRENT_YEAR - 5;
  const state   = AU_STATES.has(car.state) ? car.state : 'NSW';

  console.log(`[revalue-garage] ▶ ${car.year} ${car.make} ${car.model}${car.trim ? ' ' + car.trim : ''} state=${state}`);

  // Step 1: Supabase comparable listings (mileage-free query)
  const vehicleObj   = { make: car.make, model: car.model, yearLow: yearNum, yearHigh: yearNum };
  const userInputObj = { state, mileageUnknown: true };

  let comparableMeta = { listings: [], totalFound: 0, source: 'no_data' };
  try {
    comparableMeta = await getComparableListings(vehicleObj, userInputObj);
  } catch (e) {
    console.error('[revalue-garage] comparables error:', e.message);
  }

  // Step 2: Market average from scans table
  let marketAvgMid = null;
  try {
    marketAvgMid = await getMarketAverage(car.make, car.model, yearNum);
  } catch (e) {
    console.error('[revalue-garage] marketAvg error:', e.message);
  }

  console.log(`[revalue-garage] ▶ ${comparableMeta.totalFound} listings | marketAvg=$${marketAvgMid ?? 'n/a'}`);

  // Step 3: Call Claude
  const userPrompt = buildRevalueUserPrompt({ ...car, state }, comparableMeta.listings);

  const anthropicBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system: PHASE2_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  };

  try {
    const jsonText = await callAnthropic(anthropicBody);
    const parsed   = JSON.parse(jsonText);

    console.log(`[revalue-garage] ✓ mid=$${parsed.finalValuation?.mid} confidence=${parsed.confidenceScore}`);

    // Step 4: Save analytics (fire-and-forget, flagged as garage revaluation)
    saveScan(vehicleObj, { ...userInputObj, postcode: '' }, parsed, comparableMeta, true);

    return res.status(200).json({
      ...parsed,
      marketAvgMid,
      dataSource:       comparableMeta.source,
      realListingsUsed: comparableMeta.totalFound,
    });
  } catch (err) {
    console.error(`[revalue-garage] ✗ ${err.message}`);
    return res.status(err.status ?? 500).json({ error: sanitiseError(err) });
  }
};
