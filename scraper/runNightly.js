// Nightly scraper job — runs all target make/model combinations.
// Run with: node scraper/runNightly.js
// Or via npm: npm run scrape

'use strict';

// Load .env.local for local runs (dotenv optional — falls back to shell env)
try { require('dotenv').config({ path: '.env.local' }); } catch {}

const { scrapeSearch, saveListings, markStaleListings, closeBrowser } = require('./autotrader');

// ---------------------------------------------------------------------------
// Target searches
// ---------------------------------------------------------------------------

// maxPages: 5 for high-volume/high-demand models, 3 for others
const TARGETS = [
  // ── Toyota ────────────────────────────────────────────────
  { make: 'Toyota',          model: 'RAV4',          maxPages: 5 },
  { make: 'Toyota',          model: 'HiLux',         maxPages: 5 },
  { make: 'Toyota',          model: 'Camry',         maxPages: 5 },
  { make: 'Toyota',          model: 'Corolla',       maxPages: 5 },
  { make: 'Toyota',          model: 'LandCruiser',   maxPages: 5 },
  { make: 'Toyota',          model: 'LandCruiser Prado', maxPages: 5 },
  { make: 'Toyota',          model: 'Yaris',         maxPages: 3 },
  { make: 'Toyota',          model: 'C-HR',          maxPages: 3 },
  { make: 'Toyota',          model: 'Fortuner',      maxPages: 3 },
  // ── Ford ──────────────────────────────────────────────────
  { make: 'Ford',            model: 'Ranger',        maxPages: 5 },
  { make: 'Ford',            model: 'Mustang',       maxPages: 3 },
  { make: 'Ford',            model: 'Escape',        maxPages: 3 },
  { make: 'Ford',            model: 'Everest',       maxPages: 3 },
  { make: 'Ford',            model: 'Focus',         maxPages: 3 },
  // ── Mazda ─────────────────────────────────────────────────
  { make: 'Mazda',           model: 'CX-5',          maxPages: 5 },
  { make: 'Mazda',           model: '3',             maxPages: 5 },
  { make: 'Mazda',           model: '2',             maxPages: 3 },
  { make: 'Mazda',           model: '6',             maxPages: 3 },
  { make: 'Mazda',           model: 'BT-50',         maxPages: 3 },
  { make: 'Mazda',           model: 'MX-5',          maxPages: 3 },
  // ── Hyundai ───────────────────────────────────────────────
  { make: 'Hyundai',         model: 'Tucson',        maxPages: 5 },
  { make: 'Hyundai',         model: 'i30',           maxPages: 5 },
  { make: 'Hyundai',         model: 'Santa Fe',      maxPages: 3 },
  { make: 'Hyundai',         model: 'Kona',          maxPages: 3 },
  // ── Kia ───────────────────────────────────────────────────
  { make: 'Kia',             model: 'Cerato',        maxPages: 5 },
  { make: 'Kia',             model: 'Sportage',      maxPages: 5 },
  { make: 'Kia',             model: 'Sorento',       maxPages: 3 },
  { make: 'Kia',             model: 'Stinger',       maxPages: 3 },
  { make: 'Kia',             model: 'Carnival',      maxPages: 3 },
  // ── Mitsubishi ────────────────────────────────────────────
  { make: 'Mitsubishi',      model: 'Outlander',     maxPages: 3 },
  { make: 'Mitsubishi',      model: 'Triton',        maxPages: 5 },
  { make: 'Mitsubishi',      model: 'Eclipse Cross', maxPages: 3 },
  { make: 'Mitsubishi',      model: 'ASX',           maxPages: 3 },
  // ── Nissan ────────────────────────────────────────────────
  { make: 'Nissan',          model: 'X-Trail',       maxPages: 3 },
  { make: 'Nissan',          model: 'Navara',        maxPages: 3 },
  { make: 'Nissan',          model: 'Patrol',        maxPages: 3 },
  { make: 'Nissan',          model: 'Qashqai',       maxPages: 3 },
  // ── Honda ─────────────────────────────────────────────────
  { make: 'Honda',           model: 'CR-V',          maxPages: 3 },
  { make: 'Honda',           model: 'Civic',         maxPages: 3 },
  { make: 'Honda',           model: 'Jazz',          maxPages: 3 },
  // ── Subaru ────────────────────────────────────────────────
  { make: 'Subaru',          model: 'Forester',      maxPages: 3 },
  // ── Volkswagen ────────────────────────────────────────────
  { make: 'Volkswagen',      model: 'Golf',          maxPages: 5 },
  { make: 'Volkswagen',      model: 'Tiguan',        maxPages: 3 },
  { make: 'Volkswagen',      model: 'Amarok',        maxPages: 3 },
  { make: 'Volkswagen',      model: 'Passat',        maxPages: 3 },
  // ── BMW ───────────────────────────────────────────────────
  { make: 'BMW',             model: '3 Series',      maxPages: 3 },
  { make: 'BMW',             model: 'X3',            maxPages: 3 },
  { make: 'BMW',             model: 'X5',            maxPages: 3 },
  // ── Mercedes-Benz ─────────────────────────────────────────
  { make: 'Mercedes-Benz',   model: 'C-Class',       maxPages: 3 },
  { make: 'Mercedes-Benz',   model: 'A-Class',       maxPages: 3 },
  { make: 'Mercedes-Benz',   model: 'GLC-Class',     maxPages: 3 },
  { make: 'Mercedes-Benz',   model: 'E-Class',       maxPages: 3 },
  // ── Audi ──────────────────────────────────────────────────
  { make: 'Audi',            model: 'A3',            maxPages: 3 },
  // ── Isuzu ─────────────────────────────────────────────────
  { make: 'Isuzu',           model: 'D-Max',         maxPages: 5 },
  { make: 'Isuzu',           model: 'MU-X',          maxPages: 3 },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function runNightly() {
  const startTime = Date.now();
  console.log(`\n=== AutoVal nightly scrape — ${new Date().toISOString()} ===\n`);

  const summary = [];

  for (const { make, model, maxPages } of TARGETS) {
    console.log(`\n─── ${make} ${model} (maxPages=${maxPages}) ───────────────────────────────────────`);

    try {
      const listings = await scrapeSearch({ make, model, maxPages });

      if (listings.length === 0) {
        console.log(`  No listings found — skipping save`);
        summary.push({ make, model, found: 0, saved: 0, error: null });
        continue;
      }

      const { inserted } = await saveListings(listings);

      const activeURLs = listings.map(l => l.listing_url).filter(Boolean);
      await markStaleListings(make, model, activeURLs);

      console.log(`  ✓ Saved ${inserted} listing(s) (${listings.length} scraped)`);
      summary.push({ make, model, found: listings.length, saved: inserted, error: null });
    } catch (err) {
      console.error(`  ✗ Error scraping ${make} ${model}: ${err.message}`);
      summary.push({ make, model, found: 0, saved: 0, error: err.message });
    }

    // Brief pause between make/model searches
    await new Promise(r => setTimeout(r, 3000));
  }

  // Print summary table
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n\n=== Summary (${elapsed}s) ===`);
  console.log('Make + Model'.padEnd(30), 'Found'.padEnd(8), 'Saved'.padEnd(8), 'Status');
  console.log('─'.repeat(60));
  for (const row of summary) {
    const label = `${row.make} ${row.model}`.padEnd(30);
    const found = String(row.found).padEnd(8);
    const saved = String(row.saved).padEnd(8);
    const status = row.error ? `✗ ${row.error.slice(0, 40)}` : '✓';
    console.log(label, found, saved, status);
  }

  const totalFound = summary.reduce((s, r) => s + r.found, 0);
  const totalSaved = summary.reduce((s, r) => s + r.saved, 0);
  const errors = summary.filter(r => r.error).length;
  console.log('─'.repeat(60));
  console.log(`TOTAL: ${totalFound} scraped, ${totalSaved} saved, ${errors} error(s)\n`);
}

runNightly()
  .catch(err => { console.error('Fatal error:', err); process.exitCode = 1; })
  .finally(() => closeBrowser());
