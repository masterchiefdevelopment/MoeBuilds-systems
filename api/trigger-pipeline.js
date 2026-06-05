// Vercel serverless function — /api/trigger-pipeline
// POST: Fires GitHub Actions workflow_dispatch (run_poller: yes)
// GET:  Health check — confirms the function is deployed and GITHUB_PAT is set

const OWNER         = 'masterchiefdevelopment';
const REPO          = 'MoeBuilds-systems';
const WORKFLOW_FILE = 'agents.yml';

module.exports = async function handler(req, res) {
  console.log(`[trigger-pipeline] ${req.method} ${req.url}`);

  // ── GET: deployment / env-var health check ──────────────────────────────
  if (req.method === 'GET') {
    const pat = process.env.GITHUB_PAT;
    console.log('[trigger-pipeline] Health check — GITHUB_PAT:', pat ? 'set ✓' : 'MISSING ✗');
    if (!pat) {
      return res.status(500).json({
        status: 'error',
        message: 'GITHUB_PAT not set — add it in Vercel → Settings → Environment Variables',
      });
    }
    return res.status(200).json({ status: 'ok', message: 'Function deployed and GITHUB_PAT is set' });
  }

  // ── POST: dispatch workflow ─────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.error('[trigger-pipeline] ERROR: GITHUB_PAT is not set');
    return res.status(500).json({
      error: 'GITHUB_PAT not configured',
      fix:   'Add GITHUB_PAT in Vercel → Settings → Environment Variables',
    });
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  console.log('[trigger-pipeline] Calling GitHub API:', url);

  let ghRes;
  try {
    ghRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${pat}`,
        Accept:         'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref:    'main',
        inputs: { run_poller: 'yes', client_id: '' },
      }),
    });
  } catch (err) {
    console.error('[trigger-pipeline] Network error reaching GitHub:', err.message);
    return res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }

  console.log('[trigger-pipeline] GitHub API response:', ghRes.status);

  if (!ghRes.ok) {
    const detail = await ghRes.text();
    console.error('[trigger-pipeline] GitHub API error:', ghRes.status, detail);
    return res.status(502).json({ error: `GitHub API error ${ghRes.status}`, detail });
  }

  console.log('[trigger-pipeline] Workflow dispatched successfully');
  return res.status(200).json({ ok: true });
};
