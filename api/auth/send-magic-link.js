// POST /api/auth/send-magic-link
// Sends a Supabase magic-link OTP email. No password required.

const { checkAppSecret, sanitiseError } = require('../_lib');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10kb' } },
};

// Simple in-memory rate limit: max 3 sends per email per hour.
const emailAttempts = new Map(); // email → [timestamps]

function checkEmailRateLimit(email) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const attempts = (emailAttempts.get(email) ?? []).filter(t => now - t < windowMs);
  if (attempts.length >= 3) {
    return { allowed: false, retryAfter: Math.ceil((attempts[0] + windowMs - now) / 1000) };
  }
  attempts.push(now);
  emailAttempts.set(email, attempts);
  return { allowed: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAppSecret(req)) return res.status(401).json({ error: 'Unauthorised' });

  const { email } = req.body ?? {};
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const normalised = email.toLowerCase().trim();
  const rateCheck = checkEmailRateLimit(normalised);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Too many sign-in attempts for this email. Try again later.',
      retryAfter: rateCheck.retryAfter,
    });
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  const { error } = await supabase.auth.signInWithOtp({
    email: normalised,
    options: {
      emailRedirectTo: 'autoval://auth/callback',
      shouldCreateUser: true,
    },
  });

  if (error) {
    console.error('[send-magic-link] Supabase error:', error.message);
    return res.status(500).json({ error: sanitiseError(error) });
  }

  console.log(`[send-magic-link] ✓ sent to ${normalised.replace(/(.{2}).*@/, '$1***@')}`);
  return res.status(200).json({ success: true });
};
