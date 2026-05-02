-- AutoVal scan analytics table
-- Run in Supabase SQL Editor: Dashboard → SQL Editor → New query → paste → Run

CREATE TABLE IF NOT EXISTS scans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  scanned_at timestamp with time zone DEFAULT now(),

  -- Vehicle identification
  make text,
  model text,
  year integer,
  trim text,
  body_type text,
  colour text,
  drive_type text,
  cv_confidence integer,

  -- Condition signals
  paint_condition text,
  panel_condition text,
  overall_condition text,

  -- User inputs
  odometer integer,
  mileage_unknown boolean,
  user_condition text,
  state text,
  postcode text,           -- nulled on account deletion

  -- Valuation results
  valuation_low integer,
  valuation_mid integer,
  valuation_high integer,
  confidence_score integer,
  market_insight text,

  -- Comparable data
  comparables_found integer,
  regional_demand text,
  market_velocity text,

  -- Meta
  used_real_listings boolean,
  real_listings_count integer,
  is_garage_revaluation boolean DEFAULT false,
  additional_details text, -- nulled on account deletion (free-text, may contain PII)
  user_id text,            -- nulled on account deletion
  scan_mode text DEFAULT 'valuation',
  app_version text,
  scan_duration_seconds integer
);

CREATE INDEX IF NOT EXISTS idx_scans_make_model        ON scans (make, model);
CREATE INDEX IF NOT EXISTS idx_scans_state             ON scans (state);
CREATE INDEX IF NOT EXISTS idx_scans_scanned_at        ON scans (scanned_at);
CREATE INDEX IF NOT EXISTS idx_scans_make_model_yr_st  ON scans (make, model, year, state);
