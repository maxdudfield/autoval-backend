# Serverless Function Consolidation Plan

Vercel Hobby plan limit: **12 functions**. Currently at **11** (after test-alert removal).
One slot remaining before hitting the ceiling again.

---

## Current inventory

| File | Description |
|------|-------------|
| `scan.js` | Phase 1 vision — accepts images, returns vehicle ID via Claude |
| `value.js` | Phase 2 pricing — valuation via Claude + Supabase comparables |
| `revalue-garage.js` | Text-only garage revaluation without photos |
| `events.js` | Batch analytics event sink |
| `health.js` | Static health check |
| `auth/send-magic-link.js` | Sends Supabase magic link email |
| `auth/verify-token.js` | Verifies magic link JWT, upserts user profile |
| `auth/apple-signin.js` | Apple Sign In — creates or finds user by apple_user_id |
| `feedback/check-pending.js` | Daily cron — finds scans needing feedback prompt |
| `feedback/submit.js` | Records user's post-sale outcome |
| `user/scans.js` | Returns user's last 50 scans for cross-device sync |
| `user/delete.js` | GDPR account deletion |

---

## Consolidation candidates

### Option A: `user/*` → `user.js` — saves 1 slot (easiest)

`scans.js` is GET, `delete.js` is DELETE — clean HTTP method routing.

```js
// api/user.js
module.exports = withErrorReporting(async (req, res) => {
  if (req.method === 'GET')    return handleScans(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
});
```

**iOS impact:** URL changes from `/api/user/scans` → `/api/user` and
`/api/user/delete` → `/api/user`. Update `AnthropicService.swift` (or wherever
these are called). Coordinate iOS release with backend deploy.

---

### Option B: `auth/*` → `auth.js` — saves 2 slots (highest value)

Route on a `action` body field (consistent with existing body-first pattern).

```js
// api/auth.js
module.exports = withErrorReporting(async (req, res) => {
  const { action } = req.body ?? {};
  if (action === 'send-magic-link') return handleSendMagicLink(req, res);
  if (action === 'verify-token')    return handleVerifyToken(req, res);
  if (action === 'apple-signin')    return handleAppleSignIn(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});
```

**iOS impact:** URL changes from `/api/auth/send-magic-link` etc. to
`/api/auth` with `action` in the body. Update `AuthService.swift`.
Coordinate iOS release with backend deploy.

---

### Option C: `feedback/*` → `feedback.js` — saves 1 slot

Route on `action` body field or HTTP method (check-pending is cron-only,
submit is user-facing — both POST, so use `action`).

```js
// api/feedback.js
module.exports = withErrorReporting(async (req, res) => {
  const { action } = req.body ?? {};
  if (action === 'check-pending') return handleCheckPending(req, res);
  if (action === 'submit')        return handleSubmit(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});
```

**iOS impact:** `FeedbackScreen` POST URL changes from `/api/feedback/submit`
to `/api/feedback` with `action: 'submit'` in the body. Also update
GitHub Actions workflow which POSTs to `/api/feedback/check-pending`.

---

## Recommended order

1. **Option A** (`user/*`) — method-based routing, minimal logic change, 1 slot freed
2. **Option B** (`auth/*`) — biggest saving (2 slots), slightly more routing logic
3. **Option C** (`feedback/*`) — fine but lowest urgency

All three combined: **12 → 8 functions**, 4 slots free for future growth.

Each option requires a coordinated iOS + backend deploy since URLs change.
Do not merge backend changes until the iOS build referencing new URLs is
ready to submit — otherwise auth/sync breaks for existing users.
