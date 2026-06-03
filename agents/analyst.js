// Analyst Agent - tracks visitors and revenue per client app
console.log('[ANALYST] Script loaded');

require('dotenv/config');
const { createClient } = require('@supabase/supabase-js');
const { Anthropic }    = require('@anthropic-ai/sdk');
const { Resend }       = require('resend');

// ─── Config ────────────────────────────────────────────────────────────────
const NOTIFY_EMAIL  = 'moebuildsco@gmail.com';
const REPORT_WINDOW = 7; // days to look back for analytics data

// ─── Logging helper ────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[ANALYST][${step}] ${msg}`);
}

// ─── Date helper ──────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Fetch analytics rows for one client over the report window ────────────
// Expects an `analytics` table with columns:
//   client_id, event_type ('pageview'|'click'|'conversion'), page, referrer, created_at
async function fetchAnalytics(supabase, clientId) {
  const since = daysAgo(REPORT_WINDOW);

  const { data, error } = await supabase
    .from('analytics')
    .select('event_type, page, referrer, created_at')
    .eq('client_id', clientId)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Analytics fetch failed for ${clientId}: ${error.message}`);
  return data || [];
}

// ─── Aggregate raw rows into summary stats ─────────────────────────────────
function aggregateStats(rows) {
  const pageviews   = rows.filter(r => r.event_type === 'pageview');
  const clicks      = rows.filter(r => r.event_type === 'click');
  const conversions = rows.filter(r => r.event_type === 'conversion');

  // Unique days with any activity
  const activeDays = new Set(rows.map(r => r.created_at.slice(0, 10))).size;

  // Top pages by view count
  const pageCounts = pageviews.reduce((acc, r) => {
    acc[r.page || '/'] = (acc[r.page || '/'] || 0) + 1;
    return acc;
  }, {});
  const topPages = Object.entries(pageCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([page, count]) => ({ page, count }));

  // Top referrers
  const refCounts = pageviews.reduce((acc, r) => {
    if (r.referrer) acc[r.referrer] = (acc[r.referrer] || 0) + 1;
    return acc;
  }, {});
  const topReferrers = Object.entries(refCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([referrer, count]) => ({ referrer, count }));

  return {
    totalPageviews:   pageviews.length,
    totalClicks:      clicks.length,
    totalConversions: conversions.length,
    activeDays,
    topPages,
    topReferrers,
  };
}

// ─── Claude: generate plain-english weekly report ─────────────────────────
async function generateReport(client, stats, anthropic) {
  log('CLAUDE', `Generating report for "${client.business_name}"`);

  const windowLabel = `${formatDate(daysAgo(REPORT_WINDOW))} – ${formatDate(new Date().toISOString())}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are writing a weekly analytics report for the owner of Moe Builds Co.
The report covers the website for their client: "${client.business_name}" (a ${client.business_type}, ${client.package} package).
Report period: ${windowLabel} (${REPORT_WINDOW} days).

Analytics summary:
- Total page views: ${stats.totalPageviews}
- Total button/link clicks: ${stats.totalClicks}
- Total conversions (form submits / contact requests): ${stats.totalConversions}
- Days with any traffic: ${stats.activeDays} of ${REPORT_WINDOW}
- Top pages: ${stats.topPages.length ? stats.topPages.map(p => `${p.page} (${p.count} views)`).join(', ') : 'no data'}
- Top referrers: ${stats.topReferrers.length ? stats.topReferrers.map(r => `${r.referrer} (${r.count})`).join(', ') : 'no referrer data'}

Write a concise 3-4 paragraph plain-english summary:
1. Overall traffic health this week (positive/neutral/concerning)
2. What's working — highlight any strong pages or referrers
3. What to watch or improve — low conversions, dead traffic days, etc.
4. One actionable recommendation

Keep the tone professional but friendly. No bullet points — prose only.`,
    }],
  });

  return message.content[0].text.trim();
}

// ─── Resend: send weekly report email ─────────────────────────────────────
async function sendReportEmail(resend, client, stats, reportText) {
  const subject = `Weekly Client Report - ${client.business_name}`;
  log('EMAIL', `Sending: "${subject}"`);

  const topPagesHtml = stats.topPages.length
    ? `<table style="border-collapse:collapse;width:100%;margin-top:8px">
        ${stats.topPages.map(p => `
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:6px 0;font-family:monospace;font-size:13px">${p.page}</td>
            <td style="padding:6px 0;text-align:right;color:#555">${p.count} views</td>
          </tr>`).join('')}
       </table>`
    : '<p style="color:#aaa;font-size:13px">No page data this week</p>';

  const { data, error } = await resend.emails.send({
    from: 'MoeBuilds Analytics <onboarding@resend.dev>',
    to:   [NOTIFY_EMAIL],
    subject,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:640px;margin:auto;padding:32px;color:#1a1a1a">
        <h2 style="margin:0 0 4px">📊 Weekly Client Report</h2>
        <p style="margin:0 0 24px;color:#888;font-size:14px">${client.business_name} — ${client.business_type} — ${client.package} package</p>

        <!-- Stat pills -->
        <div style="display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap">
          ${[
            ['Page Views',   stats.totalPageviews,   '#2563eb'],
            ['Clicks',       stats.totalClicks,       '#16a34a'],
            ['Conversions',  stats.totalConversions,  '#9333ea'],
            ['Active Days',  `${stats.activeDays}/7`, '#ea580c'],
          ].map(([label, val, color]) => `
            <div style="flex:1;min-width:120px;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;text-align:center">
              <div style="font-size:24px;font-weight:700;color:${color}">${val}</div>
              <div style="font-size:12px;color:#888;margin-top:2px">${label}</div>
            </div>`).join('')}
        </div>

        <!-- Claude narrative -->
        <h3 style="margin:0 0 12px;font-size:16px">Weekly Summary</h3>
        <div style="line-height:1.8;color:#444;font-size:15px">
          ${reportText.split('\n\n').map(p => `<p style="margin:0 0 14px">${p}</p>`).join('')}
        </div>

        <!-- Top pages -->
        <h3 style="margin:24px 0 8px;font-size:16px">Top Pages</h3>
        ${topPagesHtml}

        ${stats.topReferrers.length ? `
        <h3 style="margin:24px 0 8px;font-size:16px">Top Referrers</h3>
        <p style="font-size:13px;color:#555">${stats.topReferrers.map(r => `${r.referrer} (${r.count})`).join(' &middot; ')}</p>` : ''}

        <p style="margin-top:32px;font-size:12px;color:#bbb;border-top:1px solid #eee;padding-top:16px">
          Moe Builds Co. — Automated Analytics Pipeline
        </p>
      </div>
    `,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  log('EMAIL', `Sent — message id: ${data?.id}`);
}

// ─── Main orchestration ────────────────────────────────────────────────────
async function main() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[ANALYST] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resend    = new Resend(process.env.RESEND_API_KEY);

  // Step 1: Load all delivered clients
  log('START', 'Analyst Agent starting — fetching delivered clients');

  const { data: clients, error: clientsErr } = await supabase
    .from('clients')
    .select('*')
    .eq('status', 'delivered')
    .order('business_name', { ascending: true });

  if (clientsErr) {
    console.error(`[ANALYST] Supabase error: ${clientsErr.message}`);
    process.exit(1);
  }

  if (!clients || clients.length === 0) {
    log('START', 'No delivered clients found. Nothing to report.');
    process.exit(0);
  }

  log('START', `Found ${clients.length} delivered client(s)`);

  let successCount = 0;
  let failCount    = 0;

  // Step 2–5: Process each client independently so one failure doesn't block others
  for (const client of clients) {
    log('CLIENT', `─── ${client.business_name} (id: ${client.id}) ───`);

    try {
      // Step 2: Fetch analytics data for this client (last 7 days)
      log('SUPABASE', `Fetching analytics for "${client.business_name}"`);
      const rows = await fetchAnalytics(supabase, client.id);
      log('SUPABASE', `${rows.length} event(s) in the last ${REPORT_WINDOW} days`);

      // Step 3: Aggregate into summary stats
      const stats = aggregateStats(rows);
      log('STATS', `Views: ${stats.totalPageviews} | Clicks: ${stats.totalClicks} | Conversions: ${stats.totalConversions} | Active days: ${stats.activeDays}`);

      // Step 4: Generate plain-english report via Claude
      const reportText = await generateReport(client, stats, anthropic);
      log('CLAUDE', `Report generated (${reportText.length} chars)`);

      // Step 5: Send email via Resend
      await sendReportEmail(resend, client, stats, reportText);

      successCount++;
      log('CLIENT', `✓ Report sent for "${client.business_name}"`);
    } catch (err) {
      failCount++;
      log('CLIENT', `✗ Failed for "${client.business_name}": ${err.message}`);
    }
  }

  log('DONE', `Analyst complete — ${successCount} report(s) sent, ${failCount} failed`);
}

main().catch(err => {
  console.error(`[ANALYST] Fatal: ${err.message}`);
  process.exit(1);
});
