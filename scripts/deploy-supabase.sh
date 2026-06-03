#!/usr/bin/env bash
# deploy-supabase.sh — deploy edge functions + apply DB webhook triggers
#
# Prerequisites:
#   export SUPABASE_ACCESS_TOKEN=sbp_xxxx
#   # Get yours at: https://supabase.com/dashboard/account/tokens
#
# Usage:
#   bash scripts/deploy-supabase.sh
#   bash scripts/deploy-supabase.sh --sql-only     # skip function deploy, only apply SQL
#   bash scripts/deploy-supabase.sh --fns-only     # skip SQL, only deploy functions

set -euo pipefail

PROJECT_REF="ulzijveryrnfthschghw"
FUNCTIONS=(trigger-builder trigger-auditor trigger-qa)
SQL_ONLY=false
FNS_ONLY=false

for arg in "$@"; do
  case $arg in
    --sql-only) SQL_ONLY=true ;;
    --fns-only) FNS_ONLY=true ;;
  esac
done

# ── 0. Check access token ─────────────────────────────────────────────────────
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo ""
  echo "  ERROR: SUPABASE_ACCESS_TOKEN is not set."
  echo ""
  echo "  1. Go to https://supabase.com/dashboard/account/tokens"
  echo "  2. Generate a new token named 'MoeBuilds deploy'"
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
  echo "→ Supabase CLI not found — installing..."
  curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
    | tar -xz -C /tmp/
  SUPA="/tmp/supabase"
fi
echo "→ Supabase CLI: $($SUPA --version)"

# ── 2. Link project ───────────────────────────────────────────────────────────
echo "→ Linking to project $PROJECT_REF..."
$SUPA link --project-ref "$PROJECT_REF"

# ── 3. Deploy edge functions ──────────────────────────────────────────────────
if [[ "$SQL_ONLY" == false ]]; then
  for fn in "${FUNCTIONS[@]}"; do
    echo "→ Deploying function: $fn ..."
    $SUPA functions deploy "$fn" --no-verify-jwt
    echo "  ✓ https://$PROJECT_REF.supabase.co/functions/v1/$fn"
  done
fi

# ── 4. Apply DB webhook triggers ──────────────────────────────────────────────
if [[ "$FNS_ONLY" == false ]]; then
  echo ""
  echo "→ Applying webhook trigger SQL..."

  # Attempt supabase db push first.
  # If the migration was previously recorded as applied (even partially),
  # db push will skip it.  In that case we fall back to running the SQL
  # directly via psql / the Supabase SQL editor.
  if $SUPA db push 2>&1 | tee /tmp/db-push.log; then
    echo "  ✓ Migration applied via supabase db push"
  else
    echo ""
    echo "  ⚠  supabase db push failed or migration already recorded."
    echo "     Running the trigger SQL directly against the database..."

    # Get the DB connection string from the linked project
    DB_URL=$($SUPA status --output env 2>/dev/null | grep DB_URL | cut -d= -f2- || true)

    if [[ -n "$DB_URL" ]]; then
      psql "$DB_URL" -f supabase/migrations/20260603000001_webhooks.sql
      echo "  ✓ Trigger SQL applied via psql"
    else
      echo ""
      echo "  ────────────────────────────────────────────────────────────"
      echo "  MANUAL STEP REQUIRED"
      echo "  ────────────────────────────────────────────────────────────"
      echo "  supabase db push could not run automatically."
      echo ""
      echo "  Go to: https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
      echo "  Paste and run the contents of:"
      echo "    supabase/migrations/20260603000001_webhooks.sql"
      echo "  ────────────────────────────────────────────────────────────"
      echo ""
    fi
  fi
fi

# ── 5. Set edge function secrets reminder ─────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  NEXT: Set Edge Function secrets in Supabase Dashboard       ║"
echo "║  Dashboard → Edge Functions → Manage secrets                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  GITHUB_PAT    = <GitHub PAT with repo + workflow scopes>    ║"
echo "║  GITHUB_OWNER  = masterchiefdevelopment                      ║"
echo "║  GITHUB_REPO   = MoeBuilds-systems                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Or set via CLI:"
echo "    $SUPA secrets set GITHUB_PAT=ghp_xxxx"
echo "    $SUPA secrets set GITHUB_OWNER=masterchiefdevelopment"
echo "    $SUPA secrets set GITHUB_REPO=MoeBuilds-systems"
echo ""
echo "✓ Deploy complete."
