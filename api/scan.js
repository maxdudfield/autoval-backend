const { checkRateLimit, callAnthropic, PHASE1_SYSTEM_PROMPT, buildPhase1UserPrompt } = require('./_lib');

// Increase body size limit to handle multiple base64 images.
module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
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
  const { images } = req.body ?? {};
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images array is required' });
  }
  for (const img of images) {
    if (!img.b64 || typeof img.b64 !== 'string') {
      return res.status(400).json({ error: 'each image must have a b64 string field' });
    }
  }

  // Build Anthropic request
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
    console.error('[scan]', err.message);
    return res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
  }
};
