-- AutoVal scan outcomes table
-- Captures real sale prices from users to improve valuation accuracy.
-- Run in Supabase SQL Editor: Dashboard → SQL Editor → New query → paste → Run

CREATE TABLE IF NOT EXISTS scan_outcomes (
  id                uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_id           uuid    REFERENCES scans(id) ON DELETE CASCADE,
  user_id           text,                            -- nullable (anonymised on account deletion)
  created_at        timestamptz DEFAULT now(),
  prompted_at       timestamptz DEFAULT now(),        -- when we asked the user
  responded_at      timestamptz,                      -- when they answered (null = pending)
  outcome           text,                             -- 'sold' | 'still_listed' | 'kept' | 'declined_to_say'
  actual_sale_price integer,                          -- what they actually sold for
  our_valuation_mid integer,                          -- what we estimated at scan time
  variance_pct      numeric(6,2),                     -- (actual - estimated) / estimated * 100
  days_to_sell      integer                           -- days from scan to sale (nullable)
);

CREATE INDEX IF NOT EXISTS idx_scan_outcomes_scan_id      ON scan_outcomes (scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_outcomes_user_id      ON scan_outcomes (user_id);
CREATE INDEX IF NOT EXISTS idx_scan_outcomes_created_at   ON scan_outcomes (created_at);
CREATE INDEX IF NOT EXISTS idx_scan_outcomes_prompted_at  ON scan_outcomes (prompted_at);
CREATE INDEX IF NOT EXISTS idx_scan_outcomes_outcome      ON scan_outcomes (outcome)
  WHERE outcome IS NOT NULL;

-- Prevent duplicate pending rows for the same scan
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_outcomes_scan_id_unique ON scan_outcomes (scan_id);

COMMENT ON TABLE  scan_outcomes IS 'Post-sale feedback from users — links actual prices to our valuations.';
COMMENT ON COLUMN scan_outcomes.variance_pct IS '(actual_sale_price - our_valuation_mid) / our_valuation_mid * 100. Negative = we overestimated.';
COMMENT ON COLUMN scan_outcomes.user_id      IS 'Nulled on account deletion.';
