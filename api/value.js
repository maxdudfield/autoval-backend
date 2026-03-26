const { checkRateLimit, callAnthropic, PHASE2_SYSTEM_PROMPT, buildPhase2UserPrompt } = require('./_lib');

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

  const anthropicBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: PHASE2_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildPhase2UserPrompt(vehicle, userInputs),
    }],
  };

  try {
    const jsonText = await callAnthropic(anthropicBody);
    const parsed = JSON.parse(jsonText);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('[value]', err.message);
    return res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
  }
};
