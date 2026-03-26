#!/usr/bin/env node
// Quick smoke-test for the AutoVal backend.
// Usage: node test.js
// Requires: ANTHROPIC_API_KEY set in .env.local or your shell environment.
//
// By default tests against localhost (vercel dev).
// Set BASE_URL env var to test against production:
//   BASE_URL=https://autoval-backend.vercel.app node test.js

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

// Load .env.local if running locally and dotenv is available, otherwise rely on shell env.
try {
  require('dotenv').config({ path: '.env.local' });
} catch {
  // dotenv not installed — that's fine, just use shell env
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function post(path, body) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

function pass(label) { console.log(`  ✓  ${label}`); }
function fail(label, detail) { console.error(`  ✗  ${label}\n     ${detail}`); process.exitCode = 1; }

// --------------------------------------------------------------------------
// Test /api/value (no real image needed)
// --------------------------------------------------------------------------

async function testValue() {
  console.log('\n── /api/value ──────────────────────────────────────────');

  // 1. Missing body fields
  const bad = await post('/api/value', {});
  bad.status === 400
    ? pass('returns 400 when vehicle missing')
    : fail('returns 400 when vehicle missing', `got ${bad.status}: ${JSON.stringify(bad.json)}`);

  // 2. Valid minimal request
  const vehicle = {
    make: 'Toyota', model: 'Camry', year: 2019, trim: 'Ascent',
    bodyType: 'Sedan', colour: 'White', driveType: 'FWD',
    conditionSignals: { paint: 'Good', panelWork: 'No visible damage', tyres: 'Good', overall: 'Very Good' },
    cvConfidence: 85,
    detectedFeatures: ['alloy wheels'],
  };
  const userInputs = {
    mileage: 75000, mileageUnknown: false,
    condition: 'Good', state: 'NSW', postcode: '2000',
  };

  console.log('  Calling /api/value (live Anthropic call — may take ~5 s)…');
  const ok = await post('/api/value', { vehicle, userInputs });

  if (ok.status === 200) {
    const v = ok.json;
    pass(`HTTP 200 received`);
    v.finalValuation?.mid ? pass(`finalValuation.mid = $${v.finalValuation.mid.toLocaleString()}`) : fail('finalValuation.mid missing', JSON.stringify(v));
    v.confidenceScore != null ? pass(`confidenceScore = ${v.confidenceScore}`) : fail('confidenceScore missing', JSON.stringify(v));
    Array.isArray(v.adjustments) && v.adjustments.length >= 3 ? pass(`${v.adjustments.length} adjustments returned`) : fail('adjustments missing or too few', JSON.stringify(v));
    console.log(`  ℹ  marketInsight: "${v.marketInsight}"`);
  } else {
    fail(`HTTP ${ok.status}`, JSON.stringify(ok.json));
  }
}

// --------------------------------------------------------------------------
// Test /api/scan (uses a tiny 1×1 white JPEG encoded as base64)
// --------------------------------------------------------------------------

async function testScan() {
  console.log('\n── /api/scan ───────────────────────────────────────────');

  // 1. Missing images array
  const bad = await post('/api/scan', {});
  bad.status === 400
    ? pass('returns 400 when images missing')
    : fail('returns 400 when images missing', `got ${bad.status}: ${JSON.stringify(bad.json)}`);

  // 2. Valid minimal request — 1×1 white JPEG (Claude will score low confidence but still return JSON)
  // This is the smallest valid JPEG: 1×1 white pixel.
  const tinyJpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB/8QAHRAAAgIDAQEBAAAAAAAAAAAAAQIDBAUREiH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqt2ra2pYFdXVQqqFVRwAAOAAPIAA/9k=';

  console.log('  Calling /api/scan (live Anthropic call — may take ~5 s)…');
  const ok = await post('/api/scan', { images: [{ b64: tinyJpeg, mime: 'image/jpeg' }] });

  if (ok.status === 200) {
    const v = ok.json;
    pass(`HTTP 200 received`);
    v.make != null ? pass(`make = "${v.make}"`) : fail('make field missing', JSON.stringify(v));
    v.cvConfidence != null ? pass(`cvConfidence = ${v.cvConfidence}`) : fail('cvConfidence missing', JSON.stringify(v));
    v.conditionSignals ? pass('conditionSignals present') : fail('conditionSignals missing', JSON.stringify(v));
    console.log(`  ℹ  identificationNotes: "${v.identificationNotes}"`);
  } else {
    fail(`HTTP ${ok.status}`, JSON.stringify(ok.json));
  }
}

// --------------------------------------------------------------------------
// Run
// --------------------------------------------------------------------------

(async () => {
  console.log(`\nAutoVal backend tests → ${BASE_URL}`);

  if (!process.env.ANTHROPIC_API_KEY && BASE_URL.includes('localhost')) {
    console.warn('\n  ⚠  ANTHROPIC_API_KEY is not set. Live Anthropic calls will fail.\n     Add it to .env.local or export it in your shell.\n');
  }

  await testValue();
  await testScan();

  console.log(process.exitCode === 1 ? '\n❌  Some tests failed.\n' : '\n✅  All tests passed.\n');
})();
