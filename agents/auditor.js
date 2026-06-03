// Auditor Agent - reviews builder output for quality issues

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

// ─── GitHub config ─────────────────────────────────────────────────────────
const GITHUB_API   = 'https://api.github.com';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'masterchiefdevelopment';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'moe-builds-co';

// ─── Logging helper ────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[AUDITOR][${step}] ${msg}`);
}

// ─── GitHub: fetch a file from a branch via Contents API ───────────────────
async function fetchFileFromBranch(branch, filePath) {
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res  = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub contents fetch → ${res.status}: ${err}`);
  }
  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

// ─── Local fast checks (regex-based, no API call needed) ──────────────────
function runLocalChecks(html, client) {
  const results = {};
  const issues  = [];

  // Business name must appear at least once in the rendered text
  results.has_business_name = html.includes(client.business_name);
  if (!results.has_business_name) {
    issues.push(`Business name "${client.business_name}" not found in HTML`);
  }

  // Brand color must be present in CSS (case-insensitive hex comparison)
  const colorLower = (client.brand_color || '').toLowerCase();
  results.brand_color_correct = colorLower ? html.toLowerCase().includes(colorLower) : true;
  if (!results.brand_color_correct) {
    issues.push(`Brand color "${client.brand_color}" not found in HTML`);
  }

  // No unreplaced {{PLACEHOLDER}} tokens should remain
  const placeholderMatches = html.match(/\{\{[A-Z_]+\}\}/g);
  results.no_placeholders = !placeholderMatches;
  if (placeholderMatches) {
    const unique = [...new Set(placeholderMatches)];
    issues.push(`Unreplaced placeholders found: ${unique.join(', ')}`);
  }

  // Hero section — look for the .hero class or an <h1>/<h2> near the top
  results.has_hero_section = /class=["'][^"']*hero[^"']*["']/.test(html);
  if (!results.has_hero_section) {
    issues.push('Hero/banner section not found (expected element with class "hero")');
  }

  // Services or menu section
  results.has_services_or_menu =
    /#services|id=["']services["']|#menu|id=["']menu["']/i.test(html);
  if (!results.has_services_or_menu) {
    issues.push('No services or menu section found (expected id="services" or id="menu")');
  }

  // CTA — at minimum a contact section or a link to #contact/#booking
  results.has_cta =
    /#contact|id=["']contact["']|#booking|id=["']booking["']/.test(html);
  if (!results.has_cta) {
    issues.push('No call-to-action section found (expected id="contact" or id="booking")');
  }

  // Footer
  results.has_footer = /<footer[\s>]/i.test(html);
  if (!results.has_footer) {
    issues.push('No <footer> element found');
  }

  return { results, issues };
}

// ─── Claude deep review ────────────────────────────────────────────────────
async function reviewWithClaude(html, client, localIssues, anthropic) {
  log('CLAUDE', 'Sending HTML to Claude for semantic review');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a QA reviewer for a website builder. You are reviewing the generated HTML for a ${client.business_type} called "${client.business_name}".

The following local checks already ran and produced these issues (may be empty):
${localIssues.length ? localIssues.map(i => `- ${i}`).join('\n') : '(none)'}

Now review the HTML for additional semantic problems:
- Does the hero headline sound generic or unrelated to a ${client.business_type}?
- Is the about text suspiciously short, cut off, or clearly placeholder-like?
- Are there any visible HTML encoding errors or raw tags showing as text?
- Does the overall copy feel coherent and professional?

HTML to review:
${html.slice(0, 6000)}${html.length > 6000 ? '\n...(truncated)' : ''}

Return ONLY a JSON object:
{
  "additional_issues": []  // array of strings describing NEW issues only, empty if none
}`,
    }],
  });

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  }
}

// ─── Main orchestration ────────────────────────────────────────────────────
async function main() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[AUDITOR] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Step 1: Claim the oldest client in 'auditing' status
  log('START', 'Auditor Agent starting — scanning for clients in auditing status');

  const { data: clients, error: fetchError } = await supabase
    .from('clients')
    .select('*')
    .eq('status', 'auditing')
    .order('updated_at', { ascending: true })
    .limit(1);

  if (fetchError) {
    console.error(`[AUDITOR] Supabase error: ${fetchError.message}`);
    process.exit(1);
  }

  if (!clients || clients.length === 0) {
    log('START', 'No clients currently in auditing status. Nothing to do.');
    process.exit(0);
  }

  const client = clients[0];
  log('SUPABASE', `Auditing: "${client.business_name}" (id: ${client.id}, branch: ${client.github_branch})`);

  if (!client.github_branch) {
    console.error('[AUDITOR] Client has no github_branch set — cannot fetch HTML. Exiting.');
    process.exit(1);
  }

  // Step 2: Fetch generated index.html from the client's GitHub branch
  log('GITHUB', `Fetching index.html from branch "${client.github_branch}"`);
  let html;
  try {
    html = await fetchFileFromBranch(client.github_branch, 'index.html');
    log('GITHUB', `Fetched ${html.length.toLocaleString()} chars`);
  } catch (e) {
    console.error(`[AUDITOR] Failed to fetch index.html: ${e.message}`);
    process.exit(1);
  }

  // Step 3: Run local regex-based checks (fast, deterministic)
  log('CHECKS', 'Running local checks');
  const { results: localResults, issues: localIssues } = runLocalChecks(html, client);

  // Log local check results
  log('CHECKS', '─'.repeat(55));
  for (const [check, passed] of Object.entries(localResults)) {
    log('CHECKS', `${passed ? '✓' : '✗'} ${check}`);
  }

  // Step 4: Ask Claude to review for semantic / copy quality issues
  const { additional_issues: claudeIssues } = await reviewWithClaude(html, client, localIssues, anthropic);

  if (claudeIssues.length) {
    log('CHECKS', `✗ Claude found ${claudeIssues.length} additional issue(s):`);
    claudeIssues.forEach(i => log('CHECKS', `    → ${i}`));
  } else {
    log('CHECKS', '✓ Claude review: copy looks good');
  }
  log('CHECKS', '─'.repeat(55));

  // Merge all issues
  const allIssues = [...localIssues, ...claudeIssues];
  const passed    = allIssues.length === 0;

  // Step 5: Update Supabase based on audit outcome
  if (!passed) {
    log('RESULT', `FAILED — ${allIssues.length} issue(s) found:`);
    allIssues.forEach((issue, i) => log('RESULT', `  ${i + 1}. ${issue}`));

    const { error: buildingErr } = await supabase
      .from('clients')
      .update({ status: 'building', audit_notes: allIssues.join('; ') })
      .eq('id', client.id);

    if (buildingErr) throw new Error(`Failed to revert status: ${buildingErr.message}`);
    log('SUPABASE', `Status → 'building' | Issues logged to audit_notes`);
    log('DONE', 'Audit failed — client sent back to builder for fixes.');
  } else {
    log('RESULT', 'PASSED — all checks passed, no issues found');

    const { error: qaErr } = await supabase
      .from('clients')
      .update({ status: 'qa', audit_notes: null })
      .eq('id', client.id);

    if (qaErr) throw new Error(`Failed to promote status to qa: ${qaErr.message}`);
    log('SUPABASE', `Status → 'qa'`);
    log('DONE', 'Audit passed — client promoted to QA.');
  }
}

main().catch(err => {
  console.error(`[AUDITOR] Fatal: ${err.message}`);
  process.exit(1);
});
