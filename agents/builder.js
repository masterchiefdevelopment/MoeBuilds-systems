// Builder Agent - reads client intake and builds the app
console.log('[BUILDER] Script loaded');

require('dotenv/config');
const { createClient } = require('@supabase/supabase-js');
const { Anthropic }    = require('@anthropic-ai/sdk');
// Node 18+ has fetch built-in — no node-fetch needed

// ─── GitHub target repo ────────────────────────────────────────────────────
const GITHUB_API   = 'https://api.github.com';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'masterchiefdevelopment';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'moe-builds-co';

// ─── Test mode: fake client used when --test flag is passed ────────────────
const TEST_CLIENT = {
  id:            'test-001',
  business_name: 'Via 313 Pizza',
  business_type: 'foodtruck',
  package:       'standard',
  brand_color:   '#E03030',
};

// ─── Logging helper ────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[BUILDER][${step}] ${msg}`);
}

// ─── Slug helper ───────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── GitHub API helper ─────────────────────────────────────────────────────
async function githubFetch(path, method = 'GET', body = null) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Template builder ──────────────────────────────────────────────────────
// Sections available per business type × package tier
const SECTIONS = {
  barbershop: {
    starter:  ['Hero', 'About', 'Services', 'Contact'],
    standard: ['Hero', 'About', 'Services', 'Gallery', 'Contact'],
    premium:  ['Hero', 'About', 'Services', 'Gallery', 'Team', 'Booking', 'Contact'],
  },
  foodtruck: {
    starter:  ['Hero', 'About', 'Menu', 'Contact'],
    standard: ['Hero', 'About', 'Menu', 'Schedule', 'Contact'],
    premium:  ['Hero', 'About', 'Menu', 'Schedule', 'Catering', 'Gallery', 'Contact'],
  },
};

function buildSectionHtml(section, businessType) {
  switch (section) {
    case 'Hero':
      return `  <div class="hero">
    <h2>{{HERO_HEADLINE}}</h2>
    <p>{{HERO_SUBTEXT}}</p>
  </div>`;
    case 'About':
      return `  <section id="about">
    <h2>About Us</h2>
    <p>{{ABOUT_TEXT}}</p>
  </section>`;
    case 'Services':
      return `  <section id="services">
    <h2>Our Services</h2>
    <div class="card-grid">{{SERVICES_HTML}}</div>
  </section>`;
    case 'Menu':
      return `  <section id="menu">
    <h2>Our Menu</h2>
    <div class="card-grid">{{MENU_HTML}}</div>
  </section>`;
    case 'Gallery':
      return `  <section id="gallery">
    <h2>Gallery</h2>
    <p>{{GALLERY_TEXT}}</p>
  </section>`;
    case 'Team':
      return `  <section id="team">
    <h2>Meet the Team</h2>
    <p>{{TEAM_TEXT}}</p>
  </section>`;
    case 'Booking':
      return `  <section id="booking">
    <h2>Book an Appointment</h2>
    <p>{{BOOKING_TEXT}}</p>
  </section>`;
    case 'Schedule':
      return `  <section id="schedule">
    <h2>Find Us</h2>
    <p>{{SCHEDULE_TEXT}}</p>
  </section>`;
    case 'Catering':
      return `  <section id="catering">
    <h2>Catering</h2>
    <p>{{CATERING_TEXT}}</p>
  </section>`;
    case 'Contact':
      return `  <section id="contact">
    <h2>Contact</h2>
    <p>{{CONTACT_TEXT}}</p>
  </section>`;
    default:
      return '';
  }
}

function selectTemplate(businessType, pkg) {
  const tiers = SECTIONS[businessType];
  if (!tiers) throw new Error(`Unknown business_type: "${businessType}". Expected: barbershop | foodtruck`);
  const sections = tiers[pkg];
  if (!sections) throw new Error(`Unknown package: "${pkg}". Expected: starter | standard | premium`);

  const sectionHtml = sections.map(s => buildSectionHtml(s, businessType)).join('\n');

  // Shared CSS; business-type-specific card styles injected inline
  const cardCss = businessType === 'barbershop'
    ? '.card-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:1rem; margin-top:1rem; } .card { border:2px solid var(--brand); border-radius:8px; padding:1rem; text-align:center; font-weight:600; }'
    : '.card-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; margin-top:1rem; } .card { border-left:4px solid var(--brand); padding:.75rem 1rem; background:#f9f9f9; font-weight:600; }';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{BUSINESS_NAME}}</title>
  <style>
    :root { --brand: {{BRAND_COLOR}}; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; color: #1a1a1a; }
    header { background: var(--brand); color: #fff; padding: 1.5rem 2rem; display:flex; align-items:center; justify-content:space-between; }
    header h1 { font-size: 1.8rem; letter-spacing: -.5px; }
    nav a { color:#fff; text-decoration:none; margin-left:1.5rem; font-size:.95rem; }
    .hero { background: var(--brand); color: #fff; text-align:center; padding: 6rem 2rem; }
    .hero h2 { font-size: 2.5rem; margin-bottom: 1rem; }
    .hero p  { font-size: 1.1rem; opacity: .9; max-width:600px; margin:auto; }
    section { padding: 4rem 2rem; max-width: 900px; margin: auto; }
    section h2 { color: var(--brand); margin-bottom: 1rem; font-size: 1.5rem; }
    section p  { line-height: 1.8; color: #555; }
    ${cardCss}
    footer { background: #111; color: #aaa; text-align:center; padding: 2rem; font-size:.85rem; }
  </style>
</head>
<body>
  <header>
    <h1>{{BUSINESS_NAME}}</h1>
    <nav>${sections.filter(s => s !== 'Hero').map(s => `<a href="#${s.toLowerCase()}">${s}</a>`).join('')}</nav>
  </header>
${sectionHtml}
  <footer>
    <p>&copy; {{BUSINESS_NAME}} &mdash; Built by <a href="#" style="color:#888">Moe Builds Co.</a></p>
  </footer>
</body>
</html>`;
}

// ─── Claude content generation ─────────────────────────────────────────────
async function generateContent(client, anthropic) {
  const { business_name, business_type, package: pkg } = client;
  log('CLAUDE', `Generating copy for "${business_name}" (${business_type}, ${pkg} tier)`);

  const extraField = business_type === 'barbershop'
    ? '"services": an array of 3-4 service name strings (e.g. "Fade", "Beard Trim", "Hot Towel Shave")'
    : '"menu_items": an array of 3-4 food item name strings (e.g. "Smash Burger", "Street Tacos", "Loaded Fries")';

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are writing website copy for a ${business_type} called "${business_name}".
Package tier: ${pkg}.

Return a JSON object with ONLY these exact keys:
- "hero_headline": a punchy 6-10 word headline for the hero banner
- "hero_subtext": a single tagline sentence, max 20 words
- "about_text": a 2-3 sentence paragraph, warm and professional
- ${extraField}
- "contact_text": one sentence with a friendly call to action

Return ONLY the JSON object. No markdown, no extra text.`,
    }],
  });

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Strip any accidental markdown fences Claude might have added
    const cleaned = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  }
}

// ─── Apply content + branding to template ─────────────────────────────────
function applyContent(html, client, content) {
  const { business_name, brand_color, business_type } = client;

  const servicesHtml = (content.services || [])
    .map(s => `<div class="card">${s}</div>`)
    .join('');

  const menuHtml = (content.menu_items || [])
    .map(m => `<div class="card">${m}</div>`)
    .join('');

  return html
    .replace(/\{\{BUSINESS_NAME\}\}/g,  business_name)
    .replace(/\{\{BRAND_COLOR\}\}/g,    brand_color || '#2563eb')
    .replace(/\{\{HERO_HEADLINE\}\}/g,  content.hero_headline  || '')
    .replace(/\{\{HERO_SUBTEXT\}\}/g,   content.hero_subtext   || '')
    .replace(/\{\{ABOUT_TEXT\}\}/g,     content.about_text     || '')
    .replace(/\{\{SERVICES_HTML\}\}/g,  servicesHtml)
    .replace(/\{\{MENU_HTML\}\}/g,      menuHtml)
    .replace(/\{\{CONTACT_TEXT\}\}/g,   content.contact_text   || '')
    .replace(/\{\{GALLERY_TEXT\}\}/g,   'Photos coming soon.')
    .replace(/\{\{TEAM_TEXT\}\}/g,      'Meet our talented team — the best in the business.')
    .replace(/\{\{BOOKING_TEXT\}\}/g,   'Book your appointment online or give us a call.')
    .replace(/\{\{SCHEDULE_TEXT\}\}/g,  'Follow us on social media for daily locations and hours.')
    .replace(/\{\{CATERING_TEXT\}\}/g,  'Bring the experience to your event. Contact us for catering packages.');
}

// ─── GitHub: create branch + single atomic commit ─────────────────────────
async function createBranchAndPush(branchName, files, commitMessage) {
  log('GITHUB', `Fetching main branch SHA from ${GITHUB_OWNER}/${GITHUB_REPO}`);
  const refData    = await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/main`);
  const mainSha    = refData.object.sha;

  log('GITHUB', `Base commit: ${mainSha.slice(0, 7)}`);
  const commitData  = await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${mainSha}`);
  const baseTreeSha = commitData.tree.sha;

  // Create branch pointing at main
  log('GITHUB', `Creating branch "${branchName}"`);
  await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`, 'POST', {
    ref: `refs/heads/${branchName}`,
    sha: mainSha,
  });

  // Upload file blobs
  log('GITHUB', `Uploading ${files.length} file(s) as blobs`);
  const treeItems = await Promise.all(
    files.map(async ({ path, content }) => {
      const blob = await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, 'POST', {
        content:  Buffer.from(content).toString('base64'),
        encoding: 'base64',
      });
      return { path, mode: '100644', type: 'blob', sha: blob.sha };
    })
  );

  // Build new tree on top of main's tree
  log('GITHUB', 'Creating git tree');
  const tree = await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, 'POST', {
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // Create commit
  log('GITHUB', 'Creating commit');
  const commit = await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, 'POST', {
    message: commitMessage,
    tree:    tree.sha,
    parents: [mainSha],
  });

  // Advance branch ref to the new commit
  log('GITHUB', `Pushing commit ${commit.sha.slice(0, 7)} to "${branchName}"`);
  await githubFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branchName}`, 'PATCH', {
    sha: commit.sha,
  });

  return commit.sha;
}

// ─── Main orchestration ────────────────────────────────────────────────────
async function main() {
  const TEST_MODE = process.argv.includes('--test');

  // Step 1: Validate CLI arguments
  // slice(2) skips argv[0] (node binary) and argv[1] (script path).
  const clientId = process.argv.slice(2).find(a => !a.startsWith('-'));
  if (!TEST_MODE && !clientId) {
    console.error('Usage: node agents/builder.js <client_id>');
    console.error('       node agents/builder.js --test');
    process.exit(1);
  }

  // In test mode, skip Supabase + GitHub checks.
  // ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL (proxy) is sufficient for Claude calls.
  const required = TEST_MODE
    ? []
    : ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[BUILDER] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // ANTHROPIC_BASE_URL is set in Claude Code environments — the proxy handles auth.
  // Fall back to a placeholder so the SDK constructs without throwing.
  const anthropic = new Anthropic({
    apiKey:  process.env.ANTHROPIC_API_KEY || 'placeholder',
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });
  const supabase  = TEST_MODE
    ? null
    : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  if (TEST_MODE) {
    log('START', '*** TEST MODE — using fake client, skipping Supabase and GitHub ***');
  }
  log('START', `Builder Agent initializing — ${TEST_MODE ? 'test run' : `client_id: ${clientId}`}`);

  // Step 2: Load client record (real Supabase fetch or test fixture)
  let client;
  if (TEST_MODE) {
    client = TEST_CLIENT;
    log('TEST', `Using fake client: "${client.business_name}" | type: ${client.business_type} | pkg: ${client.package}`);
  } else {
    log('SUPABASE', `Fetching client record id=${clientId}`);
    const { data, error: fetchError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();
    if (fetchError || !data) {
      console.error(`[BUILDER] Failed to fetch client: ${fetchError?.message ?? 'no record found'}`);
      process.exit(1);
    }
    client = data;
    log('SUPABASE', `Client: "${client.business_name}" | type: ${client.business_type} | pkg: ${client.package}`);
  }

  // Step 3: Set status → 'building'
  if (TEST_MODE) {
    log('TEST', `[SKIPPED] Would set status → 'building' for id=${client.id}`);
  } else {
    log('SUPABASE', `Updating status → 'building'`);
    const { error: buildingErr } = await supabase
      .from('clients')
      .update({ status: 'building' })
      .eq('id', clientId);
    if (buildingErr) throw new Error(`Status update failed: ${buildingErr.message}`);
  }

  // Step 4: Select template based on business_type × package
  log('TEMPLATE', `Loading template for ${client.business_type}/${client.package}`);
  const templateHtml = selectTemplate(client.business_type, client.package);
  log('TEMPLATE', 'Template loaded');

  // Step 5: Generate customized content via Claude (runs in both modes)
  const content = await generateContent(client, anthropic);
  log('CLAUDE', `Headline: "${content.hero_headline}"`);

  // Step 6: Inject client content + branding into template
  log('TEMPLATE', 'Injecting content and brand color into template');
  const finalHtml = applyContent(templateHtml, client, content);

  // Step 7: Determine branch name
  const slug       = slugify(client.business_name);
  const branchName = `client/${slug}`;

  // Step 8: Create branch and push files to GitHub (skipped in test mode)
  const files = [
    { path: 'index.html', content: finalHtml },
    {
      // Metadata snapshot so the Auditor agent can read build context
      path:    'site.json',
      content: JSON.stringify({
        client_id:     client.id,
        business_name: client.business_name,
        business_type: client.business_type,
        package:       client.package,
        brand_color:   client.brand_color,
        generated_at:  new Date().toISOString(),
        content,
      }, null, 2),
    },
  ];

  if (TEST_MODE) {
    log('TEST', `[SKIPPED] Would create GitHub branch "${branchName}" in ${GITHUB_OWNER}/${GITHUB_REPO}`);
    log('TEST', `[SKIPPED] Would push ${files.length} file(s): ${files.map(f => f.path).join(', ')}`);
    log('TEST', `[SKIPPED] Would set status → 'auditing' and store github_branch="${branchName}"`);

    // Write the generated HTML to disk so it can be inspected locally
    const { writeFileSync } = require('fs');
    const outPath = 'test-output.html';
    writeFileSync(outPath, finalHtml, 'utf-8');
    log('TEST', `Generated HTML written to ${outPath} — open in a browser to preview`);

    log('DONE', `Test run complete. Claude API is working. Hero: "${content.hero_headline}"`);
  } else {
    const commitSha = await createBranchAndPush(
      branchName,
      files,
      `feat: generated site for ${client.business_name} (${client.package} tier)`
    );
    log('GITHUB', `Branch ready — commit ${commitSha.slice(0, 7)}`);

    // Step 9: Set status → 'auditing' and record the branch
    log('SUPABASE', `Updating status → 'auditing'`);
    const { error: auditingErr } = await supabase
      .from('clients')
      .update({ status: 'auditing', github_branch: branchName })
      .eq('id', clientId);
    if (auditingErr) throw new Error(`Status update to auditing failed: ${auditingErr.message}`);

    log('DONE', `Builder complete. Branch: ${branchName} | Commit: ${commitSha.slice(0, 7)}`);
  }
}

main().catch(err => {
  console.error(`[BUILDER] Fatal: ${err.message}`);
  process.exit(1);
});
