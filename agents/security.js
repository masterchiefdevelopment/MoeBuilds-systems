// Security Agent - monitors client apps and agent pipeline health
console.log('[SECURITY] Script loaded');

require('dotenv/config');
const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const { chromium }     = require('playwright');

// ─── Config ────────────────────────────────────────────────────────────────
const NOTIFY_EMAIL = 'moebuildsco@gmail.com';
const STUCK_HOURS  = 48; // hours before an agent is considered stuck

// ─── Logging helper ────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[SECURITY][${step}] ${msg}`);
}

// ─── Playwright: load a URL and return health info ─────────────────────────
async function probeUrl(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const tab          = await ctx.newPage();
    const consoleErrs  = [];
    const failedReqs   = [];

    tab.on('console',       msg => { if (msg.type() === 'error') consoleErrs.push(msg.text()); });
    tab.on('requestfailed', req => failedReqs.push(req.url()));

    let status = 0;
    let title  = '';
    try {
      const res = await tab.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      status    = res?.status() ?? 0;
      title     = await tab.title();
    } catch (e) {
      return { ok: false, status: 0, error: e.message, consoleErrs: [], failedReqs: [] };
    }

    return {
      ok:          status >= 200 && status < 400,
      status,
      title,
      consoleErrs,
      failedReqs,
    };
  } finally {
    await browser.close();
  }
}

// ─── Check all delivered client apps ──────────────────────────────────────
async function checkClientApps(supabase, resend) {
  log('APPS', 'Scanning delivered client apps');

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, business_name, status, preview_url, live_url, security_notes')
    .in('status', ['delivered', 'needs_repair'])
    .order('business_name');

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);

  if (!clients?.length) {
    log('APPS', 'No delivered clients found — nothing to probe');
    return;
  }

  log('APPS', `Found ${clients.length} client(s) to check`);

  for (const client of clients) {
    const url = client.live_url || client.preview_url;

    if (!url) {
      log('APPS', `⚠  "${client.business_name}" — no live_url or preview_url set, skipping`);
      continue;
    }

    log('APPS', `Probing "${client.business_name}" → ${url}`);
    const result = await probeUrl(url);

    if (!result.ok) {
      // ── Site is down ───────────────────────────────────────────────────
      const detail = result.error ?? `HTTP ${result.status}`;
      log('APPS', `✗ DOWN — ${detail}`);

      const { error: updateErr } = await supabase
        .from('clients')
        .update({ status: 'needs_repair', security_notes: `Site down: ${detail}` })
        .eq('id', client.id);

      if (updateErr) log('APPS', `  ⚠  Status update failed: ${updateErr.message}`);

      // Only alert if it wasn't already flagged — avoids duplicate emails
      if (client.status !== 'needs_repair') {
        await sendAlert(resend, `Client App Down — ${client.business_name}`, `
          <p>A delivered client site is unreachable:</p>
          <table style="border-collapse:collapse;margin-top:12px;font-size:13px">
            <tr><td style="padding:4px 16px 4px 0;color:#888">Business</td><td><strong>${client.business_name}</strong></td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#888">URL</td><td><a href="${url}">${url}</a></td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#888">Error</td><td><code>${detail}</code></td></tr>
          </table>
          <p style="margin-top:12px">Status has been updated to <code>needs_repair</code>.</p>
        `);
      }
    } else {
      // ── Site is up ─────────────────────────────────────────────────────
      const warnings = [
        ...result.consoleErrs.map(e => `Console error: ${e}`),
        ...result.failedReqs.map(r => `Failed request: ${r}`),
      ];

      if (warnings.length) {
        log('APPS', `⚠  UP but ${warnings.length} warning(s) — "${result.title}"`);
        warnings.forEach(w => log('APPS', `    ${w}`));
      } else {
        log('APPS', `✓  UP — "${result.title}" (HTTP ${result.status})`);
      }

      // Restore status if it was previously flagged as broken
      if (client.status === 'needs_repair') {
        await supabase
          .from('clients')
          .update({ status: 'delivered', security_notes: null })
          .eq('id', client.id);
        log('APPS', `  → Restored status to delivered`);
      }
    }
  }
}

// ─── Check agent health by looking for stuck pipeline statuses ────────────
// Each status represents a hand-off point; if a record sits there for more
// than STUCK_HOURS it means the responsible agent isn't processing it.
async function checkAgentHealth(supabase, resend) {
  log('AGENTS', `Checking for pipeline stages stuck > ${STUCK_HOURS}h`);

  const staleThreshold = new Date(Date.now() - STUCK_HOURS * 3_600_000).toISOString();

  const watchedStages = [
    { status: 'new',      agent: 'Builder',  note: 'Client submitted but builder has not started' },
    { status: 'building', agent: 'Builder',  note: 'Build started but never finished' },
    { status: 'auditing', agent: 'Auditor',  note: 'Awaiting audit — auditor may be stuck' },
    { status: 'qa',       agent: 'QA',       note: 'Awaiting QA — qa agent may be stuck' },
  ];

  const stuck = [];

  for (const stage of watchedStages) {
    const { data, error } = await supabase
      .from('clients')
      .select('id, business_name, updated_at')
      .eq('status', stage.status)
      .lt('updated_at', staleThreshold);

    if (error) {
      log('AGENTS', `⚠  Error querying "${stage.status}": ${error.message}`);
      continue;
    }

    if (data?.length) {
      log('AGENTS', `✗ ${stage.agent}: ${data.length} record(s) stuck in "${stage.status}" for > ${STUCK_HOURS}h`);
      data.forEach(r => log('AGENTS', `    "${r.business_name}" — last updated ${r.updated_at}`));
      stuck.push({ ...stage, clients: data });
    } else {
      log('AGENTS', `✓ ${stage.agent} ("${stage.status}"): no stale records`);
    }
  }

  if (stuck.length) {
    const rows = stuck.map(s => `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:8px 12px;font-weight:600">${s.agent}</td>
        <td style="padding:8px 12px"><code>${s.status}</code></td>
        <td style="padding:8px 12px">${s.clients.length}</td>
        <td style="padding:8px 12px">${s.clients.map(c => c.business_name).join(', ')}</td>
        <td style="padding:8px 12px;color:#888;font-size:12px">${s.note}</td>
      </tr>
    `).join('');

    await sendAlert(resend, `Agent Pipeline Stuck — ${stuck.length} Stage(s) Stalled`, `
      <p>${stuck.length} pipeline stage(s) have had no activity for more than ${STUCK_HOURS} hours:</p>
      <table style="border-collapse:collapse;width:100%;margin-top:12px;font-size:13px">
        <thead>
          <tr style="background:#f5f5f5;text-align:left">
            <th style="padding:8px 12px">Agent</th>
            <th style="padding:8px 12px">Status</th>
            <th style="padding:8px 12px">Count</th>
            <th style="padding:8px 12px">Clients</th>
            <th style="padding:8px 12px">Note</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px">Check the GitHub Actions logs for recent errors or failures.</p>
    `);
  }
}

// ─── Resend: send alert email ──────────────────────────────────────────────
async function sendAlert(resend, subject, bodyHtml) {
  log('EMAIL', `Sending alert: "${subject}"`);

  const { data, error } = await resend.emails.send({
    from: 'MoeBuilds Security <onboarding@resend.dev>',
    to:   [NOTIFY_EMAIL],
    subject: `🚨 ${subject}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:620px;margin:auto;padding:32px;color:#1a1a1a">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
          <span style="background:#e03030;color:#fff;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Alert</span>
          <span style="font-size:17px;font-weight:700">${subject}</span>
        </div>
        ${bodyHtml}
        <p style="margin-top:32px;font-size:12px;color:#aaa;border-top:1px solid #eee;padding-top:16px">
          Moe Builds Co. — Security Agent &middot; ${new Date().toUTCString()}
        </p>
      </div>
    `,
  });

  if (error) throw new Error(`Alert email failed: ${error.message}`);
  log('EMAIL', `Alert sent — id: ${data?.id}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'RESEND_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[SECURITY] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const resend   = new Resend(process.env.RESEND_API_KEY);

  log('START', 'Security Agent starting');

  // Step 1: Verify all delivered client apps are reachable
  await checkClientApps(supabase, resend);

  // Step 2: Check the pipeline for stuck agents
  await checkAgentHealth(supabase, resend);

  log('DONE', 'Security check complete');
}

main().catch(err => {
  console.error(`[SECURITY] Fatal: ${err.message}`);
  process.exit(1);
});
