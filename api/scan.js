const { checkAppSecret, checkRateLimit, callAnthropic, sanitiseError, PHASE1_SYSTEM_PROMPT, buildPhase1UserPrompt } = require('./_lib');

// Increase body size limit to handle multiple base64 images.
module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const MAX_IMAGES      = 5;
const MAX_B64_BYTES   = Math.ceil(2 * 1024 * 1024 * (4 / 3)); // 2 MB → base64 length
const VALID_MIMES     = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_RE       = /^[A-Za-z0-9+/]+=*$/;

function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0)
    return 'images array is required and must not be empty';
  if (images.length > MAX_IMAGES)
    return `maximum ${MAX_IMAGES} images per request`;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (typeof img?.b64 !== 'string' || img.b64.length === 0)
      return `image[${i}]: b64 field must be a non-empty string`;
    if (!BASE64_RE.test(img.b64))
      return `image[${i}]: b64 is not valid base64`;
    if (img.b64.length > MAX_B64_BYTES)
      return `image[${i}]: exceeds maximum size of 2 MB`;
    const mime = img.mime ?? 'image/jpeg';
    if (!VALID_MIMES.has(mime))
      return `image[${i}]: mime must be image/jpeg, image/png, or image/webp`;
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
  const { images } = req.body ?? {};
  const validationError = validateImages(images);
  if (validationError) {
    console.warn(`[SECURITY] Invalid request body from IP ${ip}: ${validationError}`);
    return res.status(400).json({ error: validationError });
  }

  console.log(`[scan] IP=${ip} images=${images.length}`);

  // ── Claude call ───────────────────────────────────────────────────────────
  const imageBlocks = images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mime ?? 'image/jpeg', data: img.b64 },
  }));

  const anthropicBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: PHASE1_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: buildPhase1UserPrompt(images.length) }],
    }],
  };

  try {
    const jsonText = await callAnthropic(anthropicBody);
    const parsed = JSON.parse(jsonText);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('[scan] error:', err.message);
    return res.status(err.status ?? 500).json({ error: sanitiseError(err) });
  }
};
