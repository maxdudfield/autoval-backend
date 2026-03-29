// Scraper smoke test
// Usage: node scraper/test.js
// Scrapes 1 page of Toyota RAV4 → saves to Supabase → queries back → prints results.

'use strict';

try { require('dotenv').config({ path: '.env.local' }); } catch {}

const { scrapeSearch, saveListings, closeBrowser } = require('./autotrader');
const { createClient } = require('@supabase/supabase-js');

function pass(msg) { console.log(`  ✓  ${msg}`); }
function fail(msg, detail) { console.error(`  ✗  ${msg}${detail ? '\n     ' + detail : ''}`); process.exitCode = 1; }

async function run() {
  console.log('\nAutoVal scraper test\n');

  // 1. Validate env
  if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY)) {
    fail('SUPABASE_URL / SUPABASE_ANON_KEY not set', 'Add them to .env.local and retry');
    return;
  }
  pass('Environment variables present');

  // 2. Scrape 1 page
  console.log('\nScraping 1 page of Toyota RAV4…');
  let listings;
  try {
    listings = await scrapeSearch({ make: 'Toyota', model: 'RAV4', maxPages: 1 });
  } catch (e) {
    fail('Scrape threw an error', e.message);
    return;
  }

  listings.length > 0
    ? pass(`Scraped ${listings.length} listing(s)`)
    : fail('Scrape returned 0 listings', 'Check console output above for selector/block details');

  if (listings.length === 0) return;

  // Print sample listing
  console.log('\n  Sample listing:');
  const sample = listings[0];
  for (const [k, v] of Object.entries(sample)) {
    console.log(`    ${k.padEnd(20)} ${v ?? '(null)'}`);
  }

  // 3. Save to Supabase
  console.log('\nSaving to Supabase…');
  let saved;
  try {
    saved = await saveListings(listings);
    pass(`Upserted ${saved.inserted} row(s)`);
  } catch (e) {
    fail('Supabase save failed', e.message);
    return;
  }

  // 4. Query back
  console.log('\nQuerying listings back from Supabase…');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
  );

  const { data, error } = await supabase
    .from('listings')
    .select('id, make, model, year, price, odometer, state, scraped_at')
    .ilike('make', 'toyota')
    .ilike('model', 'rav4')
    .eq('is_active', true)
    .order('scraped_at', { ascending: false })
    .limit(5);

  if (error) {
    fail('Supabase query failed', error.message);
    return;
  }

  pass(`Query returned ${data.length} row(s)`);

  console.log('\n  Most recent Toyota RAV4 listings in DB:');
  console.log('  ' + ['Year','Make','Model','Price','Odometer','State'].map(h => h.padEnd(14)).join(''));
  console.log('  ' + '─'.repeat(84));
  for (const row of data) {
    const cols = [
      String(row.year ?? '—').padEnd(14),
      (row.make ?? '—').padEnd(14),
      (row.model ?? '—').padEnd(14),
      (row.price ? `$${row.price.toLocaleString()}` : '—').padEnd(14),
      (row.odometer ? `${row.odometer.toLocaleString()}km` : '—').padEnd(14),
      (row.state ?? '—').padEnd(14),
    ];
    console.log('  ' + cols.join(''));
  }

  console.log(process.exitCode === 1 ? '\n❌  Some checks failed.\n' : '\n✅  All checks passed.\n');
}

run()
  .catch(e => { console.error('Fatal:', e); process.exitCode = 1; })
  .finally(() => closeBrowser());
