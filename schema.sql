-- AutoVal listings table
-- Paste this into Supabase SQL Editor (Dashboard → SQL Editor → New query → Run)

CREATE TABLE IF NOT EXISTS listings (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  make              text        NOT NULL,
  model             text        NOT NULL,
  year              integer     NOT NULL,
  trim              text,
  body_type         text,
  colour            text,
  odometer          integer,
  price             integer     NOT NULL,
  state             text,
  postcode          text,
  dealer_or_private text,
  days_listed       integer,
  listing_url       text        UNIQUE NOT NULL,
  scraped_at        timestamptz DEFAULT now(),
  is_active         boolean     DEFAULT true
);

-- Indexes for the queries run by getComparableListings()
CREATE INDEX IF NOT EXISTS idx_listings_make          ON listings (make);
CREATE INDEX IF NOT EXISTS idx_listings_model         ON listings (model);
CREATE INDEX IF NOT EXISTS idx_listings_year          ON listings (year);
CREATE INDEX IF NOT EXISTS idx_listings_state         ON listings (state);
CREATE INDEX IF NOT EXISTS idx_listings_odometer      ON listings (odometer);
CREATE INDEX IF NOT EXISTS idx_listings_price         ON listings (price);
CREATE INDEX IF NOT EXISTS idx_listings_active        ON listings (is_active);
CREATE INDEX IF NOT EXISTS idx_listings_make_model    ON listings (make, model);
CREATE INDEX IF NOT EXISTS idx_listings_scraped_at    ON listings (scraped_at DESC);
