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

const TARGETS = [
  { make: 'Toyota',          model: 'RAV4'       },
  { make: 'Toyota',          model: 'HiLux'      },
  { make: 'Toyota',          model: 'Camry'      },
  { make: 'Toyota',          model: 'Corolla'    },
  { make: 'Mazda',           model: 'CX-5'       },
  { make: 'Mazda',           model: '3'          },
  { make: 'Ford',            model: 'Ranger'     },
  { make: 'Hyundai',         model: 'Tucson'     },
  { make: 'Kia',             model: 'Cerato'     },
  { make: 'Honda',           model: 'CR-V'       },
  { make: 'Subaru',          model: 'Forester'   },
  { make: 'Volkswagen',      model: 'Golf'       },
  { make: 'BMW',             model: '3 Series'   },
  { make: 'Mercedes-Benz',   model: 'C-Class'    },
  { make: 'Audi',            model: 'A3'         },
  { make: 'Nissan',          model: 'X-Trail'    },
  { make: 'Mitsubishi',      model: 'Outlander'  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function runNightly() {
  const startTime = Date.now();
  console.log(`\n=== AutoVal nightly scrape — ${new Date().toISOString()} ===\n`);

  const summary = [];

  for (const { make, model } of TARGETS) {
    console.log(`\n─── ${make} ${model} ───────────────────────────────────────`);

    try {
      const listings = await scrapeSearch({ make, model, maxPages: 5 });

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
