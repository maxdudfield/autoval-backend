// carsales.com.au scraper
// Uses Playwright stealth to bypass Cloudflare bot detection, then cheerio
// + __NEXT_DATA__ extraction for parsing (Next.js).

'use strict';

const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

async function closeBrowser() { /* no-op — ScrapingBee is stateless */ }

// ---------------------------------------------------------------------------
// Supabase client (lazy-initialised so the module can be imported in tests)
// ---------------------------------------------------------------------------

let _supabase;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env.local');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL       = 'https://www.carsales.com.au';
const RESULTS_PER_PAGE = 12;
const REQUEST_DELAY_MS = 2000;


// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildSearchURL(make, model, yearFrom, yearTo, state, offset = 0) {
  // carsales filter format: comma-separated key.value pairs in the `q` param.
  // Use raw commas (not percent-encoded) so the URL isn't double-encoded when
  // passed as a query parameter to ScrapingBee.
  let parts = [`Service.carsales`, `Make.${make}`, `Model.${model}`];
  if (yearFrom && yearTo) parts.push(`Year.${yearFrom}.${yearTo}`);
  if (state && state !== 'ALL') parts.push(`State.${state}`);
  return `${BASE_URL}/cars/?q=${parts.join(',')}&sort=~Price&offset=${offset}`;
}

// ---------------------------------------------------------------------------
// HTTP fetch via ScrapingBee (handles DataDome + Cloudflare bot protection)
// Sign up free at https://www.scrapingbee.com — 1,000 credits/month free tier.
// Each JS-rendered request costs 5 credits. 85 pages/night = ~425 credits.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHTML(url) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_API_KEY not set in .env.local');

  // DataDome requires JS rendering. Use stealth proxy + 30s timeout.
  // Construct manually to avoid URLSearchParams double-encoding the target URL.
  const apiURL = `https://app.scrapingbee.com/api/v1/`
    + `?api_key=${encodeURIComponent(apiKey)}`
    + `&url=${encodeURIComponent(url)}`
    + `&render_js=true`
    + `&stealth_proxy=true`
    + `&country_code=au`
    + `&timeout=30000`
    + `&wait=2000`;

  const res = await fetch(apiURL, { signal: AbortSignal.timeout(90_000) });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ScrapingBee ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.text();
}

// ---------------------------------------------------------------------------
// Extraction — primary: __NEXT_DATA__ JSON blob
// ---------------------------------------------------------------------------

function extractFromNextData(html, make, model) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (!match) {
    console.log('    [nextdata] <script id="__NEXT_DATA__"> not found in page');
    return null; // null = "not found", [] = "found but empty"
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (e) {
    console.log('    [nextdata] JSON.parse failed:', e.message);
    return null;
  }

  // Walk the object to find an array that looks like listings.
  // carsales nests results differently across page types — try known paths first.
  const pageProps = data?.props?.pageProps ?? {};

  const candidates = [
    pageProps?.searchResults,
    pageProps?.listings,
    pageProps?.data?.results,
    pageProps?.initialSearchResults,
    pageProps?.initialState?.listings,
  ].filter(Boolean);

  // Also do a recursive scan for any array with price/odometer fields
  if (candidates.length === 0) {
    const found = deepFindListingsArray(data);
    if (found) candidates.push(found);
  }

  for (const candidate of candidates) {
    const arr = Array.isArray(candidate) ? candidate
      : (Array.isArray(candidate?.results) ? candidate.results : null);
    if (!arr || arr.length === 0) continue;

    const mapped = arr.map(item => mapNextDataItem(item, make, model)).filter(Boolean);
    if (mapped.length > 0) {
      console.log(`    [nextdata] extracted ${mapped.length} listing(s) from __NEXT_DATA__`);
      return mapped;
    }
  }

  console.log('    [nextdata] found __NEXT_DATA__ but could not locate listings array — inspect page structure');
  return null;
}

// Recursively look for an array whose first element has both "price" and a year-like field.
function deepFindListingsArray(obj, depth = 0) {
  if (depth > 6 || typeof obj !== 'object' || obj === null) return null;
  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (typeof first === 'object' && (first.price || first.priceValue) && (first.year || first.buildYear)) {
      return obj;
    }
  }
  for (const v of Object.values(obj)) {
    const result = deepFindListingsArray(v, depth + 1);
    if (result) return result;
  }
  return null;
}

function mapNextDataItem(item, fallbackMake, fallbackModel) {
  try {
    const rawPrice = item.price?.value ?? item.priceValue ?? item.price ?? item.askingPrice;
    const price = parseInt(String(rawPrice).replace(/[^0-9]/g, '')) || null;
    if (!price) return null; // skip items without price

    const rawOdo = item.odometer?.value ?? item.kilometres ?? item.odometer ?? item.kms;
    const odometer = parseInt(String(rawOdo ?? '').replace(/[^0-9]/g, '')) || null;

    const year = parseInt(item.year ?? item.buildYear ?? item.manufactureYear) || null;

    const href = item.href ?? item.url ?? item.listingUrl ?? item.detailUrl ?? '';
    const listing_url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    if (!href) return null;

    const seller = item.sellerType ?? (item.isDealer ? 'Dealer' : item.dealer ? 'Dealer' : 'Private');

    return {
      make:              normalise(item.make ?? item.brand ?? fallbackMake),
      model:             normalise(item.model ?? fallbackModel),
      year,
      trim:              normalise(item.badge ?? item.variant ?? item.trim ?? ''),
      body_type:         normalise(item.bodyType ?? item.vehicleType ?? ''),
      colour:            normalise(item.colour ?? item.color ?? ''),
      odometer,
      price,
      state:             normaliseState(item.state ?? item.location?.state ?? item.locationState ?? ''),
      postcode:          normalise(item.postcode ?? item.location?.postcode ?? ''),
      dealer_or_private: normalise(seller),
      days_listed:       parseInt(item.daysListed ?? item.daysOnMarket ?? '') || null,
      listing_url,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extraction — fallback: cheerio CSS selectors
// ---------------------------------------------------------------------------

function extractFromHTML(html, make, model) {
  const $ = cheerio.load(html);

  // Try progressively broader selectors — carsales class names change with deployments
  const CARD_SELECTORS = [
    'article.listing-item',
    'article[data-webm-label]',
    '[data-index]',
    '.listing-items > article',
    '.card',
  ];

  let $cards = $([]);
  for (const sel of CARD_SELECTORS) {
    $cards = $(sel);
    if ($cards.length > 0) {
      console.log(`    [html] matched ${$cards.length} cards with: ${sel}`);
      break;
    }
  }

  if ($cards.length === 0) {
    console.log('    [html] no listing cards found — carsales layout may have changed');
    // Dump first 2000 chars of body for debugging
    console.log('    [html] page preview:', $.html('body').slice(0, 2000));
    return [];
  }

  const listings = [];
  $cards.each((_, el) => {
    const $el = $(el);

    const href = $el.find('a[href*="/car-"]').first().attr('href')
      ?? $el.find('a[href*="/cars/"]').first().attr('href') ?? '';
    const listing_url = href.startsWith('http') ? href : href ? `${BASE_URL}${href}` : null;
    if (!listing_url) return;

    const priceText = $el.find('[class*="price"], [data-price]').first().text();
    const price = parseInt(priceText.replace(/[^0-9]/g, '')) || null;
    if (!price) return;

    const titleText = $el.find('h3, h2, [class*="title"], [class*="heading"]').first().text().trim();

    const yearMatch = titleText.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? parseInt(yearMatch[0]) : null;

    const kmText = $el.find('[class*="odometer"], [class*="kms"], [class*="kilometre"]').first().text();
    const odometer = parseInt(kmText.replace(/[^0-9]/g, '')) || null;

    const locationText = $el.find('[class*="location"], [class*="suburb"], [class*="state"]').first().text().trim();
    const stateMatch = locationText.match(/\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b/i);
    const state = stateMatch ? stateMatch[1].toUpperCase() : '';

    listings.push({
      make: normalise(make), model: normalise(model), year,
      trim: '', body_type: '', colour: '', odometer, price,
      state, postcode: '', dealer_or_private: '', days_listed: null,
      listing_url,
    });
  });

  console.log(`    [html] extracted ${listings.length} valid listing(s)`);
  return listings;
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

/**
 * Scrape up to maxPages of carsales results for the given make/model/state.
 * Returns an array of raw listing objects.
 */
async function scrapeSearch({ make, model, yearFrom = null, yearTo = null, state = null, maxPages = 5 }) {
  console.log(`  Scraping: ${make} ${model}${state ? ' (' + state + ')' : ''} up to ${maxPages} page(s)…`);
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * RESULTS_PER_PAGE;
    const url = buildSearchURL(make, model, yearFrom, yearTo, state, offset);
    console.log(`  Page ${page + 1}: ${url}`);

    let html;
    try {
      html = await fetchHTML(url);
    } catch (e) {
      console.error(`  fetch error: ${e.message}`);
      break;
    }

    // Check for bot block / Cloudflare challenge
    if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
      console.warn('  ⚠  Cloudflare challenge detected — stopping scrape for this search');
      break;
    }

    // Try __NEXT_DATA__ first, fall back to HTML
    let listings = extractFromNextData(html, make, model);
    if (listings === null) {
      listings = extractFromHTML(html, make, model);
    }

    if (listings.length === 0) {
      console.log(`  No results on page ${page + 1} — stopping pagination`);
      break;
    }

    all.push(...listings);
    console.log(`  Running total: ${all.length} listing(s)`);

    if (page < maxPages - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return all;
}

// ---------------------------------------------------------------------------
// Save to Supabase
// ---------------------------------------------------------------------------

/**
 * Upsert listings into Supabase. Skips duplicates by listing_url.
 * Returns { inserted, skipped }.
 */
async function saveListings(listings) {
  if (listings.length === 0) return { inserted: 0, skipped: 0 };

  const supabase = getSupabase();
  const rows = listings.map(l => ({ ...l, scraped_at: new Date().toISOString(), is_active: true }));

  // Upsert: update price/odometer/is_active if URL already exists
  const { data, error } = await supabase
    .from('listings')
    .upsert(rows, {
      onConflict: 'listing_url',
      ignoreDuplicates: false,
    })
    .select('id');

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);

  return { inserted: data?.length ?? rows.length, skipped: listings.length - (data?.length ?? 0) };
}

/**
 * Mark all listings for a given make/model as inactive if their URL
 * was not seen in the latest scrape.
 */
async function markStaleListings(make, model, activeURLs) {
  if (activeURLs.length === 0) return;

  const supabase = getSupabase();
  const { error } = await supabase
    .from('listings')
    .update({ is_active: false })
    .ilike('make', make)
    .ilike('model', model)
    .eq('is_active', true)
    .not('listing_url', 'in', `(${activeURLs.map(u => `"${u}"`).join(',')})`);

  if (error) console.warn(`  Could not mark stale listings: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalise(s) { return typeof s === 'string' ? s.trim() : (s ?? ''); }
function normaliseState(s) {
  const upper = String(s).trim().toUpperCase();
  return ['NSW','VIC','QLD','SA','WA','TAS','ACT','NT'].includes(upper) ? upper : upper;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { scrapeSearch, saveListings, markStaleListings, buildSearchURL, closeBrowser };
