// AutoTrader AU scraper
// Uses the undocumented-but-open v3 search API:
//   https://listings.platform.autotrader.com.au/api/v3/search
// No bot protection, no auth required. Returns structured JSON directly.

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

let _supabase;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env.local');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE     = 'https://listings.platform.autotrader.com.au/api/v3/search';
const LISTING_BASE = 'https://www.autotrader.com.au';
const PER_PAGE     = 50;
const DELAY_MS     = 1500; // polite delay between pages

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer':         'https://www.autotrader.com.au/',
  'Origin':          'https://www.autotrader.com.au',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function fetchPage(make, model, state, page) {
  const params = new URLSearchParams({
    make,
    model,
    ...(state && state !== 'ALL' ? { state } : {}),
    condition: 'Used',
    paginate: String(PER_PAGE),
    page: String(page),
  });
  const url = `${API_BASE}?${params}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`AutoTrader API ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

function mapListing(src) {
  try {
    const price = src.price?.advertised_price ?? src.pricingHistory?.advertised_price;
    if (!price || price <= 0) return null;

    const url = src.url ? `${LISTING_BASE}/${src.url}` : null;
    if (!url) return null;

    const createdAt = src.created_at ? new Date(src.created_at) : null;
    const daysListed = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86_400_000) : null;

    const seller = src.is_private ? 'Private' : src.is_dealer ? 'Dealer' : '';

    // Extract state/postcode from location fields or URL
    const state = src.location_state
      || (src.location?.state)
      || extractStateFromURL(src.url);

    const postcode = src.location?.postcode ?? '';

    return {
      listing_url:       url,
      make:              src.make ?? '',
      model:             src.model ?? '',
      year:              src.manu_year ?? null,
      trim:              src.variant ?? '',
      body_type:         extractBodyTypeFromURL(src.url),
      colour:            src.colour_base ?? '',
      odometer:          src.odometer ?? null,
      price,
      state:             (state ?? '').toUpperCase(),
      postcode:          String(postcode),
      dealer_or_private: seller,
      days_listed:       daysListed,
    };
  } catch {
    return null;
  }
}

// URL format: car/{id}/{make}/{model}/{state}/{suburb}/{body_type}
function extractStateFromURL(url) {
  if (!url) return '';
  const parts = url.split('/');
  return parts[4] ? parts[4].toUpperCase() : '';
}

function extractBodyTypeFromURL(url) {
  if (!url) return '';
  const parts = url.split('/');
  const raw = parts[6] ?? '';
  return raw.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

/**
 * Scrape up to maxPages of AutoTrader listings for the given make/model.
 * Returns an array of mapped listing objects.
 */
async function scrapeSearch({ make, model, state = null, maxPages = 5 }) {
  console.log(`  Scraping: ${make} ${model}${state ? ' (' + state + ')' : ''} — AutoTrader AU API`);
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    console.log(`  Page ${page}…`);

    let resp;
    try {
      resp = await fetchPage(make, model, state, page);
    } catch (e) {
      console.error(`  fetch error: ${e.message}`);
      break;
    }

    const items = resp.data ?? [];
    if (items.length === 0) {
      console.log(`  No results on page ${page} — stopping`);
      break;
    }

    const mapped = items.map(item => mapListing(item._source)).filter(Boolean);
    all.push(...mapped);
    console.log(`  Page ${page}: ${mapped.length} valid / ${items.length} raw — running total ${all.length}`);

    // If we've fetched all available pages, stop early
    const totalPages = Math.ceil((resp.total ?? 0) / PER_PAGE);
    if (page >= totalPages) break;

    if (page < maxPages) await sleep(DELAY_MS);
  }

  return all;
}

// ---------------------------------------------------------------------------
// Supabase persistence
// ---------------------------------------------------------------------------

async function saveListings(listings) {
  if (listings.length === 0) return { inserted: 0 };

  const supabase = getSupabase();
  const rows = listings.map(l => ({ ...l, scraped_at: new Date().toISOString(), is_active: true }));

  const { data, error } = await supabase
    .from('listings')
    .upsert(rows, { onConflict: 'listing_url', ignoreDuplicates: false })
    .select('id');

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
  return { inserted: data?.length ?? rows.length };
}

async function markStaleListings(make, model, activeURLs) {
  if (activeURLs.length === 0) return;
  const supabase = getSupabase();

  // Fetch all currently active listing URLs for this make/model
  const { data: existing, error: fetchErr } = await supabase
    .from('listings')
    .select('id, listing_url')
    .ilike('make', make)
    .ilike('model', model)
    .eq('is_active', true);

  if (fetchErr) { console.warn(`  Could not fetch listings for stale check: ${fetchErr.message}`); return; }

  const activeSet = new Set(activeURLs);
  const staleIds = (existing ?? []).filter(r => !activeSet.has(r.listing_url)).map(r => r.id);

  if (staleIds.length === 0) return;

  // Mark in batches of 100 to stay within URL limits
  for (let i = 0; i < staleIds.length; i += 100) {
    const batch = staleIds.slice(i, i + 100);
    const { error } = await supabase.from('listings').update({ is_active: false }).in('id', batch);
    if (error) console.warn(`  Could not mark stale batch: ${error.message}`);
  }
  console.log(`  Marked ${staleIds.length} listing(s) as inactive`);
}

// No-op — no browser to close
async function closeBrowser() {}

module.exports = { scrapeSearch, saveListings, markStaleListings, closeBrowser };
