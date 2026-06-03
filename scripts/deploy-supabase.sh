#!/usr/bin/env bash
# deploy-supabase.sh — deploys edge functions + applies DB migrations
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_xxxx   # from supabase.com/dashboard/account/tokens
#   bash scripts/deploy-supabase.sh
#
# The script will:
#   1. Install the Supabase CLI if not already on PATH
#   2. Link to the ulzijveryrnfthschghw project
#   3. Deploy all three edge functions (trigger-builder, trigger-auditor, trigger-qa)
#   4. Push the webhooks SQL migration to wire up pg_net triggers

set -euo pipefail

PROJECT_REF="ulzijveryrnfthschghw"
FUNCTIONS=(trigger-builder trigger-auditor trigger-qa)

# ── 0. Check token ────────────────────────────────────────────────────────────
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo ""
  echo "  ERROR: SUPABASE_ACCESS_TOKEN is not set."
  echo ""
  echo "  1. Go to https://supabase.com/dashboard/account/tokens"
  echo "  2. Click 'Generate new token', name it 'MoeBuilds deploy'"
  echo "  3. Run:  export SUPABASE_ACCESS_TOKEN=sbp_xxxx"
  echo "  4. Re-run this script"
  echo ""
  exit 1
fi

# ── 1. Locate or install Supabase CLI ─────────────────────────────────────────
if command -v supabase &>/dev/null; then
  SUPA="supabase"
elif [[ -x /tmp/supabase ]]; then
  SUPA="/tmp/supabase"
else
  echo "→ Installing Supabase CLI..."
  curl -sL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
    | tar -xz -C /tmp/
  SUPA="/tmp/supabase"
fi

echo "→ Supabase CLI: $($SUPA --version)"

# ── 2. Link project ───────────────────────────────────────────────────────────
echo "→ Linking to project $PROJECT_REF..."
$SUPA link --project-ref "$PROJECT_REF"

# ── 3. Deploy edge functions ──────────────────────────────────────────────────
for fn in "${FUNCTIONS[@]}"; do
  echo "→ Deploying function: $fn"
  $SUPA functions deploy "$fn" --no-verify-jwt
done

echo ""
echo "✓ Edge functions deployed:"
for fn in "${FUNCTIONS[@]}"; do
  echo "    https://$PROJECT_REF.supabase.co/functions/v1/$fn"
done

# ── 4. Push DB migration (webhook triggers) ───────────────────────────────────
echo ""
echo "→ Pushing webhook migration to database..."
$SUPA db push

echo ""
echo "✓ Done. Pipeline webhook triggers are live."
echo ""
echo "  Next steps:"
echo "  1. Add Supabase Edge Function secrets in the dashboard:"
echo "     Dashboard → Edge Functions → Manage secrets"
echo "       GITHUB_PAT    = <your GitHub PAT>"
echo "       GITHUB_OWNER  = masterchiefdevelopment"
echo "       GITHUB_REPO   = MoeBuilds-systems"
echo ""
echo "  2. Add GitHub Actions secrets:"
echo "     Settings → Secrets → Actions"
echo "       SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY,"
echo "       RESEND_API_KEY, GH_PAT, GH_OWNER, GH_REPO"
echo ""
