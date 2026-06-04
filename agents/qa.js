// QA Agent - tests for bugs before notifying owner
console.log('[QA] Script loaded');

require('dotenv/config');
const { createClient }          = require('@supabase/supabase-js');
const { Resend }                = require('resend');
const { chromium }              = require('playwright');
const { writeFileSync, unlinkSync } = require('fs');
const { tmpdir }                = require('os');
const { join }                  = require('path');
// Node 18+ has fetch built-in — no node-fetch needed

// ─── Config ────────────────────────────────────────────────────────────────
const GITHUB_API   = 'https://api.github.com';
const GITHUB_OWNER = process.env.GH_OWNER || 'masterchiefdevelopment';
const GITHUB_REPO  = process.env.GH_REPO  || 'moe-builds-co';
const NOTIFY_EMAIL = 'moebuildsco@gmail.com';

// ─── Logging helper ────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[QA][${step}] ${msg}`);
}

// ─── GitHub: fetch a file from a branch ───────────────────────────────────
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

// ─── Playwright: run all QA tests against the URL ─────────────────────────
async function runPlaywrightTests(testUrl) {
  log('PLAYWRIGHT', `Launching headless Chromium → ${testUrl}`);
  const browser = await chromium.launch({ headless: true });
  const bugs    = [];

  try {
    // ── Desktop: page load, console errors, broken resources, button visibility ──
    log('PLAYWRIGHT', 'Desktop viewport (1280×800)');
    const desktopCtx  = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopCtx.newPage();

    const consoleErrors   = [];
    const failedResources = [];

    desktopPage.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    desktopPage.on('requestfailed', req => {
      // Skip all file:// failures — they're local temp files with no external assets
      const url = req.url();
      if (!url.startsWith('file://')) {
        failedResources.push(`${req.resourceType()}: ${url} — ${req.failure()?.errorText ?? 'unknown'}`);
      }
    });

    // Test 1: page loads without HTTP error
    let loadStatus;
    try {
      const response = await desktopPage.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 });
      loadStatus = response?.status() ?? 0;
    } catch (e) {
      loadStatus = 0;
      bugs.push(`Page failed to load: ${e.message}`);
    }

    if (loadStatus && loadStatus >= 400) {
      bugs.push(`Page returned HTTP ${loadStatus}`);
      log('TEST', `✗ Page load — HTTP ${loadStatus}`);
    } else if (loadStatus) {
      log('TEST', `✓ Page load — HTTP ${loadStatus}`);
    }

    // Test 2: no JS console errors
    if (consoleErrors.length > 0) {
      bugs.push(`Console errors: ${consoleErrors.join(' | ')}`);
      log('TEST', `✗ Console errors (${consoleErrors.length}): ${consoleErrors[0]}`);
    } else {
      log('TEST', '✓ No console errors');
    }

    // Test 3: no broken resource requests (images, scripts, etc.)
    if (failedResources.length > 0) {
      bugs.push(`Broken resources: ${failedResources.join(' | ')}`);
      log('TEST', `✗ Broken resources (${failedResources.length}): ${failedResources[0]}`);
    } else {
      log('TEST', '✓ No broken resource requests');
    }

    // Test 4: all <img> elements have loaded (naturalWidth > 0 means image decoded)
    const brokenImages = await desktopPage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs
        .filter(img => !img.complete || img.naturalWidth === 0)
        .map(img => img.src || img.getAttribute('src'));
    });
    if (brokenImages.length > 0) {
      bugs.push(`Broken images: ${brokenImages.join(', ')}`);
      log('TEST', `✗ Broken images (${brokenImages.length}): ${brokenImages[0]}`);
    } else {
      log('TEST', '✓ All images loaded');
    }

    // Test 5: all links and buttons are visible and enabled
    const controls = await desktopPage.locator('a[href], button').all();
    let hiddenCount   = 0;
    let disabledCount = 0;
    for (const el of controls) {
      if (!(await el.isVisible()))  hiddenCount++;
      if (!(await el.isEnabled()))  disabledCount++;
    }
    if (hiddenCount > 0) {
      bugs.push(`${hiddenCount} link(s)/button(s) not visible on desktop`);
      log('TEST', `✗ ${hiddenCount} invisible link(s)/button(s)`);
    } else {
      log('TEST', `✓ All ${controls.length} link(s)/button(s) visible`);
    }
    if (disabledCount > 0) {
      bugs.push(`${disabledCount} button(s) are disabled`);
      log('TEST', `✗ ${disabledCount} disabled button(s)`);
    }

    await desktopCtx.close();

    // ── Mobile: layout, no overflow, page loads ────────────────────────────
    log('PLAYWRIGHT', 'Mobile viewport (375×812, isMobile)');
    const mobileCtx  = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    });
    const mobilePage = await mobileCtx.newPage();

    const mobileConsoleErrors = [];
    mobilePage.on('console', msg => {
      if (msg.type() === 'error') mobileConsoleErrors.push(msg.text());
    });

    let mobileStatus;
    try {
      const mobileRes = await mobilePage.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 });
      mobileStatus = mobileRes?.status() ?? 0;
    } catch (e) {
      mobileStatus = 0;
      bugs.push(`Mobile page failed to load: ${e.message}`);
    }

    if (mobileStatus && mobileStatus >= 400) {
      bugs.push(`Mobile: page returned HTTP ${mobileStatus}`);
      log('TEST', `✗ Mobile load — HTTP ${mobileStatus}`);
    } else if (mobileStatus) {
      log('TEST', `✓ Mobile load — HTTP ${mobileStatus}`);
    }

    // Test 6: no horizontal overflow on mobile (means layout breaks)
    const hasHorizontalOverflow = await mobilePage.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    if (hasHorizontalOverflow) {
      bugs.push('Mobile: horizontal overflow detected — layout likely broken on mobile');
      log('TEST', '✗ Mobile: horizontal overflow');
    } else {
      log('TEST', '✓ Mobile: no horizontal overflow');
    }

    // Test 7: no console errors on mobile
    if (mobileConsoleErrors.length > 0) {
      bugs.push(`Mobile console errors: ${mobileConsoleErrors.join(' | ')}`);
      log('TEST', `✗ Mobile console errors: ${mobileConsoleErrors[0]}`);
    } else {
      log('TEST', '✓ Mobile: no console errors');
    }

    // Test 8: key sections are still visible on mobile
    const sectionsVisible = await mobilePage.evaluate(() => {
      const expected = ['header', 'footer'];
      return expected.map(sel => {
        const el = document.querySelector(sel);
        return { sel, visible: !!el && el.offsetHeight > 0 };
      });
    });
    for (const { sel, visible } of sectionsVisible) {
      if (!visible) {
        bugs.push(`Mobile: <${sel}> not visible`);
        log('TEST', `✗ Mobile: <${sel}> not rendered`);
      } else {
        log('TEST', `✓ Mobile: <${sel}> visible`);
      }
    }

    await mobileCtx.close();

  } finally {
    await browser.close();
  }

  return bugs;
}

// ─── Resend: notify owner ──────────────────────────────────────────────────
async function sendNotificationEmail(resend, client, liveUrl) {
  log('EMAIL', `Sending delivery notification to ${NOTIFY_EMAIL}`);

  const { data, error } = await resend.emails.send({
    from: 'MoeBuilds System <onboarding@resend.dev>',
    to: [NOTIFY_EMAIL],
    subject: 'Client app ready for delivery',
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:auto;padding:32px">
        <h2 style="color:#16a34a;margin-bottom:8px">✅ Client Site Ready for Delivery</h2>
        <p style="color:#555">All QA checks passed. Here are the details:</p>
        <table style="border-collapse:collapse;margin:20px 0;width:100%">
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 16px 8px 0;color:#888;font-size:13px">Business</td>
            <td style="padding:8px 0;font-weight:600">${client.business_name}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 16px 8px 0;color:#888;font-size:13px">Type</td>
            <td style="padding:8px 0">${client.business_type}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 16px 8px 0;color:#888;font-size:13px">Package</td>
            <td style="padding:8px 0;text-transform:capitalize">${client.package}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 16px 8px 0;color:#888;font-size:13px">Branch</td>
            <td style="padding:8px 0;font-family:monospace;font-size:13px">${client.github_branch}</td>
          </tr>
          <tr>
            <td style="padding:8px 16px 8px 0;color:#888;font-size:13px">Live URL</td>
            <td style="padding:8px 0"><a href="${liveUrl}" style="color:#2563eb">${liveUrl}</a></td>
          </tr>
        </table>
        <a href="${liveUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:8px">
          View Live Site →
        </a>
        <p style="margin-top:32px;font-size:12px;color:#aaa">Moe Builds Co. — Automated Build Pipeline</p>
      </div>
    `,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  log('EMAIL', `Sent — message id: ${data?.id}`);
}

// ─── Main orchestration ────────────────────────────────────────────────────
async function main() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'GITHUB_TOKEN', 'RESEND_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[QA] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const resend   = new Resend(process.env.RESEND_API_KEY);

  // Step 1: Claim the oldest client in 'qa' status
  log('START', 'QA Agent starting — scanning for clients in qa status');

  const { data: clients, error: fetchError } = await supabase
    .from('clients')
    .select('*')
    .eq('status', 'qa')
    .order('updated_at', { ascending: true })
    .limit(1);

  if (fetchError) {
    console.error(`[QA] Supabase error: ${fetchError.message}`);
    process.exit(1);
  }

  if (!clients || clients.length === 0) {
    log('START', 'No clients currently in qa status. Nothing to do.');
    process.exit(0);
  }

  const client = clients[0];
  log('SUPABASE', `Testing: "${client.business_name}" (id: ${client.id})`);

  if (!client.github_branch) {
    log('ERROR', 'Client has no github_branch — cannot test');
    const { error: branchErr } = await supabase
      .from('clients')
      .update({ status: 'building', qa_notes: 'QA skipped: github_branch not set on client record' })
      .eq('id', client.id);
    if (branchErr) log('SUPABASE', `Warning: status revert failed: ${branchErr.message}`);
    else log('SUPABASE', 'Status → building (no github_branch)');
    process.exit(0);
  }

  // Step 2: Determine test URL
  // Use preview_url if already deployed; otherwise pull the HTML from GitHub
  // and serve it via a local temp file (file:// URL) for Playwright
  let testUrl    = client.preview_url || null;
  let tempFile   = null;

  if (!testUrl) {
    log('GITHUB', `No preview_url — fetching index.html from branch "${client.github_branch}"`);
    try {
      const html = await fetchFileFromBranch(client.github_branch, 'index.html');
      tempFile   = join(tmpdir(), `moebuilds-qa-${client.id}.html`);
      writeFileSync(tempFile, html, 'utf-8');
      testUrl    = `file://${tempFile}`;
      log('QA', `Saved to temp file: ${tempFile}`);
    } catch (fetchErr) {
      log('GITHUB', `Failed to fetch HTML from GitHub: ${fetchErr.message}`);
      const { error: revertErr } = await supabase
        .from('clients')
        .update({
          status:   'building',
          qa_notes: `QA setup failed: could not fetch HTML from branch "${client.github_branch}": ${fetchErr.message}`,
        })
        .eq('id', client.id);
      if (revertErr) log('SUPABASE', `Warning: status revert failed: ${revertErr.message}`);
      else log('SUPABASE', 'Status → building (GitHub fetch failed)');
      process.exit(0);
    }
  } else {
    log('QA', `Using live URL: ${testUrl}`);
  }

  // Step 3: Run all Playwright tests
  let bugs = [];
  try {
    bugs = await runPlaywrightTests(testUrl);
  } catch (e) {
    bugs = [`Playwright fatal error: ${e.message}`];
    log('PLAYWRIGHT', `Fatal error: ${e.message}`);
  } finally {
    // Clean up temp file regardless of outcome
    if (tempFile) {
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  // Step 4: Evaluate and log results
  log('RESULT', '─'.repeat(55));
  if (bugs.length > 0) {
    log('RESULT', `FAILED — ${bugs.length} bug(s) found:`);
    bugs.forEach((bug, i) => log('RESULT', `  ${i + 1}. ${bug}`));
    log('RESULT', '─'.repeat(55));

    const { error: buildingErr } = await supabase
      .from('clients')
      .update({ status: 'building', qa_notes: bugs.join('; ') })
      .eq('id', client.id);

    if (buildingErr) log('SUPABASE', `Warning: status revert failed: ${buildingErr.message}`);
    else log('SUPABASE', `Status → 'building' | Bugs logged to qa_notes`);
    log('DONE', 'QA failed — client sent back to builder for fixes.');

  } else {
    // Step 5: All tests pass — mark ready and notify owner
    log('RESULT', 'PASSED — all checks passed');
    log('RESULT', '─'.repeat(55));

    const { error: readyErr } = await supabase
      .from('clients')
      .update({ status: 'ready', qa_notes: null })
      .eq('id', client.id);

    if (readyErr) log('SUPABASE', `Warning: status update to ready failed: ${readyErr.message}`);
    else log('SUPABASE', `Status → 'ready'`);

    // Construct live URL — prefer preview_url, fall back to GitHub branch URL
    const liveUrl = client.preview_url
      || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${client.github_branch}`;

    try {
      await sendNotificationEmail(resend, client, liveUrl);
      log('DONE', `QA passed — client ready for delivery. Notification sent to ${NOTIFY_EMAIL}.`);
    } catch (emailErr) {
      log('EMAIL', `Warning: notification email failed: ${emailErr.message}`);
      log('DONE', 'QA passed — client ready for delivery (email notification failed).');
    }
  }
}

main().catch(err => {
  console.error(`[QA] Fatal: ${err.message}`);
  process.exit(1);
});
