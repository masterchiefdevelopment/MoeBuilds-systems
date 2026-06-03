// trigger-builder — Supabase Edge Function
//
// Called by a Supabase Database Webhook on:
//   Table:  clients
//   Event:  INSERT
//   Filter: status = 'new'
//
// It fires the GitHub workflow_dispatch event to kick off the Builder Agent.
//
// Supabase Secrets required (Dashboard → Edge Functions → Secrets):
//   GITHUB_PAT    — Personal Access Token with `repo` + `actions:write` scope
//   GITHUB_OWNER  — Repository owner  (e.g. masterchiefdevelopment)
//   GITHUB_REPO   — Repository name   (e.g. MoeBuilds-systems)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const WORKFLOW_FILE = 'agents.yml';
const BRANCH        = 'main';

serve(async (req: Request): Promise<Response> => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Parse Supabase webhook body
  // Shape: { type: 'INSERT', table: 'clients', record: { id, status, ... }, ... }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad Request: invalid JSON', { status: 400 });
  }

  const record = body.record as Record<string, unknown> | undefined;
  const clientId = record?.id as string | undefined;

  if (!clientId) {
    console.error('[trigger-builder] No record.id in webhook payload', body);
    return new Response('Bad Request: missing record.id', { status: 400 });
  }

  // Guard: only act on inserts of status = 'new'
  if (record?.status !== 'new') {
    console.log(`[trigger-builder] Skipping — status is "${record?.status}", not "new"`);
    return new Response('Skipped', { status: 200 });
  }

  console.log(`[trigger-builder] Triggering builder for client_id=${clientId}`);

  const pat   = Deno.env.get('GITHUB_PAT');
  const owner = Deno.env.get('GITHUB_OWNER');
  const repo  = Deno.env.get('GITHUB_REPO');

  if (!pat || !owner || !repo) {
    console.error('[trigger-builder] Missing secrets: GITHUB_PAT / GITHUB_OWNER / GITHUB_REPO');
    return new Response('Internal Server Error: missing secrets', { status: 500 });
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const ghRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept:        'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref:    BRANCH,
      inputs: {
        client_id: clientId,
        action:    'build',
      },
    }),
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    console.error(`[trigger-builder] GitHub API error ${ghRes.status}: ${text}`);
    return new Response(`GitHub API error: ${ghRes.status}`, { status: 502 });
  }

  console.log(`[trigger-builder] Workflow dispatched — client_id=${clientId}`);
  return new Response('OK', { status: 200 });
});
