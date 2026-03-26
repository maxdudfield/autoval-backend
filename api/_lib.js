// Shared utilities for AutoVal API endpoints.
// Leading underscore prevents Vercel treating this as a route.

// ---------------------------------------------------------------------------
// Rate limiter — in-memory per serverless instance (good enough for basic abuse
// prevention; for global limits use Upstash Redis).
// ---------------------------------------------------------------------------

const _rateLimitMap = new Map();

function checkRateLimit(ip, maxPerMinute = 10) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const times = (_rateLimitMap.get(ip) ?? []).filter(t => t > windowStart);
  if (times.length >= maxPerMinute) {
    _rateLimitMap.set(ip, times);
    return false;
  }
  times.push(now);
  _rateLimitMap.set(ip, times);
  return true;
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

The user will provide confirmed vehicle details. Your job is to simulate what comparable AU marketplace listings would indicate for this vehicle's current market value, then apply adjustments for its specific attributes.

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
- All prices in AUD, realistic for the current Australian used-car market.
- finalValuation must incorporate all adjustments applied to baseValuation.mid.
- Provide 3–6 adjustments — include condition, colour, regional demand, and any notable features.
- If mileage is unknown, do NOT apply a mileage adjustment; instead note the missing odometer in confidenceFactors and use a reduced confidenceScore.`;

function buildPhase2UserPrompt(vehicle, inputs) {
  const odometer = inputs.mileageUnknown
    ? 'Unknown — use fleet average for age and type. Do NOT apply a mileage adjustment.'
    : inputs.mileage != null
      ? `${inputs.mileage.toLocaleString()} km`
      : 'Unknown';

  const features = vehicle.detectedFeatures?.length
    ? vehicle.detectedFeatures.join(', ')
    : 'None detected';

  return `Please provide a market valuation for the following Australian vehicle:

Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim ?? ''}
Body type: ${vehicle.bodyType}
Colour: ${vehicle.colour}
Drive type: ${vehicle.driveType}

Owner details:
Odometer: ${odometer}
Owner-reported condition: ${inputs.condition}
State: ${inputs.state}
Postcode: ${inputs.postcode}

AI-assessed condition:
Paint: ${vehicle.conditionSignals?.paint}
Panel work: ${vehicle.conditionSignals?.panelWork}
Tyres: ${vehicle.conditionSignals?.tyres}
Overall: ${vehicle.conditionSignals?.overall}

Detected features: ${features}
CV identification confidence: ${vehicle.cvConfidence}%

Return the valuation JSON as specified in the system prompt.`;
}

module.exports = {
  checkRateLimit,
  callAnthropic,
  PHASE1_SYSTEM_PROMPT,
  buildPhase1UserPrompt,
  PHASE2_SYSTEM_PROMPT,
  buildPhase2UserPrompt,
};
