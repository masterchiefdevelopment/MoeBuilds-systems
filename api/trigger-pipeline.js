// Vercel serverless function — /api/trigger-pipeline
// Fires the GitHub Actions workflow_dispatch after a client is inserted.
// GITHUB_PAT is read from Vercel environment variables — never sent to the browser.

const OWNER         = 'masterchiefdevelopment';
const REPO          = 'MoeBuilds-systems';
const WORKFLOW_FILE = 'agents.yml';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.error('[trigger-pipeline] GITHUB_PAT env var not set');
    return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

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
    console.error('[trigger-pipeline] Network error:', err.message);
    return res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }

  if (!ghRes.ok) {
    const detail = await ghRes.text();
    console.error(`[trigger-pipeline] GitHub API ${ghRes.status}: ${detail}`);
    return res.status(502).json({ error: `GitHub API error: ${ghRes.status}`, detail });
  }

  console.log('[trigger-pipeline] Workflow dispatched successfully');
  return res.status(200).json({ ok: true });
};
