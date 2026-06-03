// Prospector Agent - finds and scores new leads
console.log('[PROSPECTOR] Script loaded');

require('dotenv/config');
const { createClient } = require('@supabase/supabase-js');
// Node 18+ has fetch built-in — no node-fetch needed

// ─── Google Places API (legacy) ────────────────────────────────────────────
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// ─── Scoring thresholds ────────────────────────────────────────────────────
// Max possible score: 5 + 2 + 2 + 1 = 10
const SCORE_NO_WEBSITE   = 5; // biggest signal — they need us most
const SCORE_LOW_RATING   = 2; // rating below 4.0 → room to help
const SCORE_FEW_REVIEWS  = 2; // fewer than 50 reviews → not yet established
const SCORE_NO_PHONE     = 1; // missing phone → likely incomplete presence

const LOW_RATING_THRESHOLD  = 4.0;
const FEW_REVIEWS_THRESHOLD = 50;

// ─── Logging helper ────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[PROSPECTOR][${step}] ${msg}`);
}

// ─── Google Places: text search ────────────────────────────────────────────
// Returns up to 20 results for a business type + zip query
async function searchPlaces(businessType, zipCode) {
  const query  = encodeURIComponent(`${businessType} near ${zipCode}`);
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const url    = `${PLACES_BASE}/textsearch/json?query=${query}&key=${apiKey}`;

  log('PLACES', `Text search: "${businessType} near ${zipCode}"`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places Text Search HTTP ${res.status}`);

  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${data.status} — ${data.error_message || ''}`);
  }

  log('PLACES', `Found ${data.results?.length ?? 0} result(s) (status: ${data.status})`);
  return data.results || [];
}

// ─── Google Places: fetch details for one place ────────────────────────────
// We request only the fields we need to keep the call efficient
async function fetchPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const fields = 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total';
  const url    = `${PLACES_BASE}/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places Details HTTP ${res.status} for ${placeId}`);

  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`Place Details error: ${data.status} for ${placeId}`);
  }

  return data.result;
}

// ─── Score a lead 1–10 ────────────────────────────────────────────────────
function scoreLead(details) {
  let score = 0;
  const reasons = [];

  if (!details.website) {
    score += SCORE_NO_WEBSITE;
    reasons.push('no website');
  }

  const rating = details.rating ?? null;
  if (rating !== null && rating < LOW_RATING_THRESHOLD) {
    score += SCORE_LOW_RATING;
    reasons.push(`low rating (${rating})`);
  }

  const reviewCount = details.user_ratings_total ?? null;
  if (reviewCount !== null && reviewCount < FEW_REVIEWS_THRESHOLD) {
    score += SCORE_FEW_REVIEWS;
    reasons.push(`few reviews (${reviewCount})`);
  }

  if (!details.formatted_phone_number) {
    score += SCORE_NO_PHONE;
    reasons.push('no phone');
  }

  // Clamp to [1, 10] — minimum 1 so every lead has a score
  score = Math.min(10, Math.max(1, score));

  return { score, reasons };
}

// ─── Upsert leads into Supabase ────────────────────────────────────────────
// Uses upsert on (name, address) to avoid duplicates if the agent reruns
async function saveLead(supabase, lead) {
  const { error } = await supabase
    .from('leads')
    .upsert(lead, { onConflict: 'name,address', ignoreDuplicates: false });

  if (error) throw new Error(`Failed to save lead "${lead.name}": ${error.message}`);
}

// ─── Main orchestration ────────────────────────────────────────────────────
async function main() {
  // Step 1: Validate CLI arguments
  const [, , businessType, zipCode] = process.argv;
  if (!businessType || !zipCode) {
    console.error('Usage: node agents/prospector.js <business_type> <zip_code>');
    console.error('Example: node agents/prospector.js barbershop 90210');
    process.exit(1);
  }

  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'GOOGLE_PLACES_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[PROSPECTOR] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  log('START', `Prospector Agent starting — type: ${businessType}, zip: ${zipCode}`);

  // Step 2: Search Google Places for businesses of this type in the zip
  let searchResults;
  try {
    searchResults = await searchPlaces(businessType, zipCode);
  } catch (e) {
    console.error(`[PROSPECTOR] Places search failed: ${e.message}`);
    process.exit(1);
  }

  if (searchResults.length === 0) {
    log('DONE', `No businesses found for "${businessType}" in ${zipCode}`);
    process.exit(0);
  }

  log('START', `Processing ${searchResults.length} result(s)...`);

  let savedCount   = 0;
  let skippedCount = 0;
  let errorCount   = 0;

  // Step 3–5: Enrich each result, score it, and save
  for (const place of searchResults) {
    const placeId = place.place_id;
    const name    = place.name;

    try {
      // Step 3: Fetch full details (phone, website) for this place
      log('PLACES', `Fetching details for "${name}" (${placeId})`);
      const details = await fetchPlaceDetails(placeId);

      const hasWebsite = Boolean(details.website);

      // Step 4: Score the lead
      const { score, reasons } = scoreLead(details);

      log('SCORE', `"${name}" → ${score}/10 (${reasons.length ? reasons.join(', ') : 'established presence'})`);

      // Step 5: Build lead record
      const lead = {
        name:         details.name    || name,
        address:      details.formatted_address || place.formatted_address || '',
        phone:        details.formatted_phone_number || null,
        website:      details.website || null,
        has_website:  hasWebsite,
        rating:       details.rating ?? null,
        review_count: details.user_ratings_total ?? null,
        score,
        business_type: businessType,
        zip_code:      zipCode,
        status:       'new',
        source:       'google_places',
      };

      // Upsert into Supabase leads table
      await saveLead(supabase, lead);
      savedCount++;
      log('SUPABASE', `Saved: "${lead.name}" (score: ${score}, website: ${hasWebsite ? 'yes' : 'no'})`);

    } catch (err) {
      errorCount++;
      log('ERROR', `Skipping "${name}": ${err.message}`);
    }
  }

  // Step 6: Final summary
  log('DONE', '─'.repeat(55));
  log('DONE', `Search complete for "${businessType}" in ${zipCode}`);
  log('DONE', `  Results found : ${searchResults.length}`);
  log('DONE', `  Leads saved   : ${savedCount}`);
  log('DONE', `  Errors        : ${errorCount}`);
  log('DONE', '─'.repeat(55));
}

main().catch(err => {
  console.error(`[PROSPECTOR] Fatal: ${err.message}`);
  process.exit(1);
});
