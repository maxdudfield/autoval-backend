// Health check endpoint — no auth required.
// Use this to verify the backend is live without calling any paid services.

const { checkRateLimit } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter });
  }

  return res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
    version: '1.0',
  });
};
