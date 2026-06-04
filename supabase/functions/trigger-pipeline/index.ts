// trigger-pipeline — Supabase Edge Function
//
// Called by the client intake form after a successful Supabase insert.
// Fires the GitHub Actions workflow_dispatch with run_poller=yes so the
// poller picks up the new client immediately instead of waiting up to 10 min.
//
// GITHUB_PAT never leaves the server — it is read from Supabase secrets.
// The browser only presents the public anon key to reach this function.
//
// Supabase Secrets required (Dashboard → Edge Functions → Secrets):
//   GITHUB_PAT    — Personal Access Token with `repo` + `actions:write` scope
//   GITHUB_OWNER  — Repository owner  (masterchiefdevelopment)
//   GITHUB_REPO   — Repository name   (MoeBuilds-systems)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const WORKFLOW_FILE = 'agents.yml';
const BRANCH        = 'main';

// Allow the intake form (served from Vercel) to call this function
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

serve(async (req: Request): Promise<Response> => {
  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }

  const pat   = Deno.env.get('GITHUB_PAT');
  const owner = Deno.env.get('GITHUB_OWNER');
  const repo  = Deno.env.get('GITHUB_REPO');

  if (!pat || !owner || !repo) {
    console.error('[trigger-pipeline] Missing secrets: GITHUB_PAT / GITHUB_OWNER / GITHUB_REPO');
    return new Response('Internal Server Error: missing secrets', {
      status: 500,
      headers: CORS_HEADERS,
    });
  }

  console.log('[trigger-pipeline] Dispatching workflow poller run');

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const ghRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${pat}`,
      Accept:         'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref:    BRANCH,
      inputs: { run_poller: 'yes', client_id: '' },
    }),
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    console.error(`[trigger-pipeline] GitHub API error ${ghRes.status}: ${text}`);
    return new Response(`GitHub API error: ${ghRes.status}`, {
      status: 502,
      headers: CORS_HEADERS,
    });
  }

  console.log('[trigger-pipeline] Workflow dispatched successfully');
  return new Response('OK', { status: 200, headers: CORS_HEADERS });
});
