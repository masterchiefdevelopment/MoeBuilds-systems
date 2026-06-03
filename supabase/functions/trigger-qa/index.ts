// trigger-qa — Supabase Edge Function
//
// Called by a Supabase Database Webhook on:
//   Table:  clients
//   Event:  UPDATE
//   Filter: status = 'qa'
//
// It fires the GitHub workflow_dispatch event to kick off the QA Agent.
// The QA agent reads the oldest 'qa' record from Supabase itself — no
// client_id input is needed.
//
// Supabase Secrets required (Dashboard → Edge Functions → Secrets):
//   GITHUB_PAT    — Personal Access Token with `repo` + `actions:write` scope
//   GITHUB_OWNER  — Repository owner  (e.g. masterchiefdevelopment)
//   GITHUB_REPO   — Repository name   (e.g. MoeBuilds-systems)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const WORKFLOW_FILE = 'agents.yml';
const BRANCH        = 'main';

serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad Request: invalid JSON', { status: 400 });
  }

  const record = body.record as Record<string, unknown> | undefined;

  // Guard: only act when the new status is 'qa'
  if (record?.status !== 'qa') {
    console.log(`[trigger-qa] Skipping — status is "${record?.status}", not "qa"`);
    return new Response('Skipped', { status: 200 });
  }

  console.log(`[trigger-qa] Triggering QA agent for client_id=${record?.id}`);

  const pat   = Deno.env.get('GITHUB_PAT');
  const owner = Deno.env.get('GITHUB_OWNER');
  const repo  = Deno.env.get('GITHUB_REPO');

  if (!pat || !owner || !repo) {
    console.error('[trigger-qa] Missing secrets: GITHUB_PAT / GITHUB_OWNER / GITHUB_REPO');
    return new Response('Internal Server Error: missing secrets', { status: 500 });
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const ghRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:          `Bearer ${pat}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':         'application/json',
    },
    body: JSON.stringify({
      ref:    BRANCH,
      inputs: {
        client_id: '',
        action:    'qa',
      },
    }),
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    console.error(`[trigger-qa] GitHub API error ${ghRes.status}: ${text}`);
    return new Response(`GitHub API error: ${ghRes.status}`, { status: 502 });
  }

  console.log('[trigger-qa] Workflow dispatched');
  return new Response('OK', { status: 200 });
});
