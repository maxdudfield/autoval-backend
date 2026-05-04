# CLAUDE.md — autoval-backend

Node.js API backend for AutoVal, deployed on Vercel. Keeps the Anthropic API key
server-side. Also contains the AutoTrader AU scraper and GitHub Actions workflows.

Companion iOS repo: `/Users/MaxDudfield/Claude/Car Value Pro/`

---

## Environment

```
Node ≥ 18
Vercel (serverless functions — each file in api/ is a route)
Supabase (PostgreSQL) — listings + scans + scan_outcomes tables
Anthropic Claude API — claude-sonnet-4-20250514
```

Local dev: `npm run dev` (Vercel CLI). Env vars in `.env.local` (gitignored).

---

## Critical: Always Use SUPABASE_SERVICE_KEY

**Never use `SUPABASE_ANON_KEY` for server-side operations.** The anon key is
blocked by RLS policies on INSERT/DELETE. All API endpoints and the scraper must use:

```js
const key = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);
```

The service key is a JWT starting `eyJ...` — NOT `sb_secret_...` (that's the
Management API key, completely different). Get it from:
Supabase Dashboard → Project Settings → API → service_role (secret).

---

## File Structure

```
api/
├── _lib.js                  # Shared: Supabase client, prompts, helpers, rate limiter
├── scan.js                  # POST /api/scan — Phase 1 vision (Claude)
├── value.js                 # POST /api/value — Phase 2 pricing (Claude + Supabase listings)
├── revalue-garage.js        # POST /api/revalue-garage — text-only garage revaluation
├── health.js                # GET /api/health
├── events.js                # POST /api/events — analytics event sink
├── feedback/
│   ├── check-pending.js     # POST /api/feedback/check-pending — daily cron, inserts pending rows
│   └── submit.js            # POST /api/feedback/submit — records user's sale outcome
├── auth/
│   ├── send-magic-link.js   # POST /api/auth/send-magic-link
│   ├── verify-token.js      # POST /api/auth/verify-token
│   └── apple-signin.js      # POST /api/auth/apple-signin
└── user/
    ├── scans.js             # GET /api/user/scans — cross-device history sync
    └── delete.js            # DELETE /api/user/delete — GDPR account deletion

scraper/
├── autotrader.js            # Puppeteer scraper for AutoTrader AU listings API
├── runNightly.js            # Runs all 55 make/model targets; called by GitHub Actions
└── carsales.js              # Legacy (unused)

migrations/
├── scans_table.sql          # Main analytics table
├── scan_outcomes_table.sql  # Post-sale feedback outcomes table (v1.1)
└── feedback_analytics.sql   # Analytics queries (run in Supabase SQL Editor)

.github/workflows/
├── scrape.yml               # Bi-monthly listings scrape (1st of odd months, 02:00 UTC)
└── feedback-check.yml       # Daily feedback prompt check (10:00 UTC)
```

---

## Auth Pattern

All endpoints check `x-autoval-secret` header against `APP_SECRET` env var via
`checkAppSecret(req, ip)` from `_lib.js`. If `APP_SECRET` is unset (local dev),
the check is bypassed.

```js
const { checkAppSecret } = require('./_lib');
if (!checkAppSecret(req, ip)) return res.status(401).json({ error: 'Unauthorised' });
```

---

## Valuation Pipeline (`api/value.js`)

1. Validate request (vehicle + userInputs)
2. `getComparableListings()` — queries `listings` table with 6-attempt fallback:
   state+tight → national+tight → state+wide → national+wide → state+any → national+any
3. Apply recency filter (drop listings scraped >60 days ago)
4. Apply `applyListingAdjustments()` — per-listing days-on-market discount:
   - 0–14d listed: −5%, 15–30d: −10%, 31–60d: −15%, 60+d: −18%
   - Prices passed to Claude are **pre-adjusted transaction values**, not asking prices
5. Call Claude (claude-sonnet-4-20250514) with adjusted comparables
6. `saveScan()` — inserts to `scans` table, **returns the Supabase UUID**
7. Return result JSON including `scanId` (UUID for iOS feedback linkage)

**Important**: Claude's system prompt (`PHASE2_SYSTEM_PROMPT`) and user prompt
(`buildPhase2UserPrompt`) tell Claude the prices are already transaction-adjusted.
Do NOT add any further "apply 10% discount" instructions — prices are pre-adjusted.

---

## Supabase Tables

### `listings` (populated by scraper)
AutoTrader AU listings with: make, model, year, trim, odometer, price, state,
dealer_or_private, days_listed, scraped_at, is_active.

### `scans` (populated by `/api/value` and `/api/revalue-garage`)
One row per completed valuation. Key fields: make, model, year, valuation_mid,
scan_mode, user_id (nullable), postcode (nulled on deletion), additional_details
(nulled on deletion). `id` UUID is returned to the iOS app as `scanId`.

### `scan_outcomes` (populated by `/api/feedback/check-pending` + `/api/feedback/submit`)
Post-sale feedback. One row per scan (unique on scan_id). Pending rows have
`responded_at = null`. Fields: outcome, actual_sale_price, our_valuation_mid,
variance_pct, days_to_sell. Run `migrations/scan_outcomes_table.sql` to create.

---

## Scraper (`scraper/autotrader.js`)

Uses Puppeteer + stealth plugin against the AutoTrader AU internal JSON API.
Saves to `listings` table. Marks stale listings (`is_active = false`) after each run.

**Run locally**: `npm run scrape` (requires `.env.local` with SUPABASE_SERVICE_KEY)
**GitHub Actions**: `.github/workflows/scrape.yml` — bi-monthly, needs secrets:
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

55 targets in `runNightly.js`. `maxPages: 5` for high-volume models (RAV4, HiLux,
Ranger, Camry, Corolla, LandCruiser, LandCruiser Prado, CX-5, Mazda3, Tucson,
i30, Cerato, Sportage, Triton, Golf, Isuzu D-Max), `maxPages: 3` for others.

---

## Feedback Loop (`api/feedback/`)

**`check-pending.js`** (POST, called daily by GitHub Actions):
- Finds valuation scans 25–35 days old with user_id set and no outcome row
- Inserts pending `scan_outcomes` rows
- Logs user_id/scan_id pairs that would receive push notifications (APNS not yet wired)
- Requires `APP_SECRET` in GitHub secrets

**`submit.js`** (POST, called by iOS app):
- Body: `{ scan_id, user_id, outcome, actual_sale_price?, days_to_sell? }`
- Valid outcomes: `sold` | `still_listed` | `kept` | `declined_to_say`
- Calculates `variance_pct = (actual - estimated) / estimated * 100`
- Returns `{ success, message, contributions, variancePct }`

---

## Account Deletion (`api/user/delete.js`)

Order: garage_cars delete → scans anonymise → users table delete → auth.admin.deleteUser.
Anonymisation nulls: `user_id`, `postcode`, `additional_details` (may contain PII).
Step 4 (auth delete) is fatal — others are non-fatal and logged.

---

## GitHub Actions Secrets Required

| Secret | Used by |
|--------|---------|
| `SUPABASE_URL` | scrape.yml, feedback-check.yml |
| `SUPABASE_SERVICE_KEY` | scrape.yml, feedback-check.yml |
| `APP_SECRET` | feedback-check.yml (x-autoval-secret header) |

---

## Known Issues / Pending

- **APNS push delivery not wired**: `check-pending.js` creates rows and logs who to
  notify, but no push is actually sent. Need to add APNs token storage to users table
  and HTTP/2 push delivery.
- **`PHASE2_SYSTEM_PROMPT` calibration examples** still reference listing prices
  (e.g. "Listed at $30,000 → transacts at $26,500"). These are now misleading since
  prices passed to Claude are pre-adjusted. Low priority, but should be cleaned up.
- **Verified Report feature** (com.autoval.report.single) — StoreKit product exists,
  UI removed in v1.1. Planned for v1.1 release.
- **`api/user/scans.js`** still has a fallback to `SUPABASE_ANON_KEY` — should be
  removed (use service key only, consistent with everything else).

---

## `.env.local` Keys

```
ANTHROPIC_API_KEY=...
APP_SECRET=9a9b8ac4006ef4295af762d9c563568872f0a752e59a15b26f577ba2a0d95b29
SUPABASE_URL=https://jptekrgdwepwfydfikcy.supabase.co
SUPABASE_ANON_KEY=eyJ...  (do not use for server ops)
SUPABASE_SERVICE_KEY=eyJ...  (use this for everything)
SCRAPINGBEE_API_KEY=...  (not currently used)
```
