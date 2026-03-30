// Health check endpoint — no auth required.
// Use this to verify the backend is live without calling any paid services.

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
    version: '1.0',
  });
};
