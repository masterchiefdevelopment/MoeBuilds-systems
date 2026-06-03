# MoeBuilds System

AI-powered website pipeline for Moe Builds Co. Automatically builds, audits, QA-tests, and delivers small-business websites using Supabase, GitHub Actions, Claude, and Playwright.

---

## How it works

```
Client intake form  →  Supabase clients table
       ↓
  status = 'new'      →  Supabase Webhook  →  trigger-builder edge fn
       ↓
  Builder Agent (GitHub Actions)  →  generates site via Claude, pushes branch
       ↓
  status = 'auditing' →  Supabase Webhook  →  trigger-auditor edge fn
       ↓
  Auditor Agent  →  regex + Claude semantic review
       ↓
  status = 'qa'       →  Supabase Webhook  →  trigger-qa edge fn
       ↓
  QA Agent  →  Playwright desktop + mobile checks  →  Resend email to owner
       ↓
  status = 'ready'  →  Owner reviews via /review  →  Approve → 'delivered'
```

Schedule jobs run independently:
- **Security Agent** — daily midnight UTC; probes all delivered sites for uptime
- **Analyst Agent** — every Monday 08:00 UTC; sends weekly analytics reports per client

---

## Setup

### 1. Supabase project

Create a project at [supabase.com](https://supabase.com). Note your **Project URL** and **anon key** from Settings → API.

#### Database tables

Run in the Supabase SQL editor:

```sql
-- Clients pipeline table
create table public.clients (
  id             uuid primary key default gen_random_uuid(),
  business_name  text not null,
  business_type  text not null,
  package        text not null,
  brand_color    text,
  owner_name     text,
  owner_email    text,
  owner_phone    text,
  status         text not null default 'new',
  github_branch  text,
  preview_url    text,
  live_url       text,
  audit_notes    text,
  qa_notes       text,
  review_notes   text,
  security_notes text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

-- Leads table (populated by prospector agent)
create table public.leads (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text,
  phone         text,
  website       text,
  rating        numeric,
  review_count  integer,
  score         integer,
  business_type text,
  zip_code      text,
  created_at    timestamptz default now(),
  unique (name, address)
);

-- Analytics table (populated by your tracking script)
create table public.analytics (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients(id),
  event_type  text,
  page        text,
  referrer    text,
  recorded_at timestamptz default now()
);
```

---

### 2. Deploy Supabase Edge Functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link your project:

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

Deploy all three trigger functions:

```bash
supabase functions deploy trigger-builder
supabase functions deploy trigger-auditor
supabase functions deploy trigger-qa
```

#### Set edge function secrets

In **Supabase Dashboard → Edge Functions → Manage secrets**, or via CLI:

```bash
supabase secrets set GITHUB_PAT=ghp_xxxx
supabase secrets set GITHUB_OWNER=masterchiefdevelopment
supabase secrets set GITHUB_REPO=MoeBuilds-systems
```

| Secret name    | Description |
|----------------|-------------|
| `GITHUB_PAT`   | GitHub PAT with `repo` + `workflow` scopes |
| `GITHUB_OWNER` | Repo owner (e.g. `masterchiefdevelopment`) |
| `GITHUB_REPO`  | This repo name (`MoeBuilds-systems`) |

---

### 3. Configure Supabase Database Webhooks

Go to **Supabase Dashboard → Database → Webhooks → Create a new webhook**.

#### Webhook 1 — trigger-builder

| Field    | Value |
|----------|-------|
| Name     | `trigger-builder` |
| Table    | `clients` |
| Events   | `INSERT` |
| Type     | Supabase Edge Function |
| Function | `trigger-builder` |

#### Webhook 2 — trigger-auditor

| Field    | Value |
|----------|-------|
| Name     | `trigger-auditor` |
| Table    | `clients` |
| Events   | `UPDATE` |
| Type     | Supabase Edge Function |
| Function | `trigger-auditor` |

#### Webhook 3 — trigger-qa

| Field    | Value |
|----------|-------|
| Name     | `trigger-qa` |
| Table    | `clients` |
| Events   | `UPDATE` |
| Type     | Supabase Edge Function |
| Function | `trigger-qa` |

> The edge functions filter by status internally — all UPDATE webhooks fire on any change, and the function skips rows that don't match the expected status.

---

### 4. GitHub Actions secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret             | Used by |
|--------------------|---------|
| `SUPABASE_URL`     | all agents |
| `SUPABASE_ANON_KEY`| all agents |
| `ANTHROPIC_API_KEY`| builder, auditor, analyst |
| `RESEND_API_KEY`   | qa, security, analyst |
| `GH_PAT`           | builder, auditor, qa (cross-repo GitHub API) |
| `GH_OWNER`         | builder, auditor, qa |
| `GH_REPO`          | builder, auditor, qa (target site repo, e.g. `moe-builds-co`) |

---

### 5. Create a GitHub PAT

1. Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Scope to both `MoeBuilds-systems` and `moe-builds-co` repos
3. Required permissions:
   - **Actions**: Read & write (triggers `workflow_dispatch`)
   - **Contents**: Read & write (pushes branches to `moe-builds-co`)
4. Save the token as **both** the `GH_PAT` GitHub Secret and the `GITHUB_PAT` Supabase secret

---

### 6. Deploy the admin UI

The `admin/` directory deploys to Vercel as a static site with no build step.

1. Connect this repo to [vercel.com](https://vercel.com)
2. Vercel reads `vercel.json` automatically
3. Pages:
   - `/` — Client intake form
   - `/dashboard` — Command Center (live pipeline view, auto-refreshes)
   - `/review?client_id=<uuid>` — Review and approve a built site

---

## Manual workflow trigger

From **GitHub → Actions → MoeBuilds Agent Pipeline → Run workflow**:

| Input       | Values |
|-------------|--------|
| `client_id` | UUID of the client (required for `build`, leave blank for `audit`/`qa`) |
| `action`    | `build` \| `audit` \| `qa` |

Useful for re-running a stuck agent or bypassing the webhook flow.

---

## Agent reference

| Agent       | File                     | Trigger                         | What it does |
|-------------|--------------------------|----------------------------------|--------------|
| Builder     | `agents/builder.js`      | `workflow_dispatch` action=build | Generates site HTML via Claude, pushes branch to target repo |
| Auditor     | `agents/auditor.js`      | `workflow_dispatch` action=audit | Regex + Claude semantic review of generated HTML |
| QA          | `agents/qa.js`           | `workflow_dispatch` action=qa    | Playwright desktop + mobile checks; Resend email on pass |
| Analyst     | `agents/analyst.js`      | cron Mon 08:00 UTC               | Weekly analytics email per delivered client |
| Security    | `agents/security.js`     | cron daily midnight UTC          | Uptime probes + stuck-agent detection |
| Prospector  | `agents/prospector.js`   | Manual CLI                       | Finds local business leads via Google Places |

Test the builder locally (no Supabase or GitHub needed):

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
npm install
node agents/builder.js --test
```

Run the prospector:

```bash
node agents/prospector.js barbershop 48201
```
