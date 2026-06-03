-- MoeBuilds pipeline webhook triggers
--
-- These functions use pg_net to POST to Supabase Edge Functions whenever a
-- client row moves through the pipeline.  They replace the manual
-- "Database Webhook" setup in the Supabase dashboard.
--
-- The anon key is used as the Bearer token.  It is intentionally public
-- (it is already embedded in the admin HTML pages) and only grants read-only
-- access to public tables — the actual work is done inside the edge functions
-- which authenticate to GitHub using server-side secrets.
--
-- Apply with:  supabase db push  (or paste into the Supabase SQL editor)

-- pg_net is pre-installed on all Supabase projects
create extension if not exists pg_net schema extensions;

-- ─── Config ────────────────────────────────────────────────────────────────
-- Centralise the project URL and anon key so they only need updating here.
do $$
begin
  perform set_config('app.supabase_url',      'https://ulzijveryrnfthschghw.supabase.co', false);
  perform set_config('app.supabase_anon_key',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    || '.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsemlqdmVyeXJuZnRoc2NoZ2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTA4MjcsImV4cCI6MjA5NjA2NjgyN30'
    || '.NIN2T5Rff2YGfpe0r5JqLewW6C5ablzzcguXdZjTZ7U',
    false);
end $$;

-- ─── Helper: POST to an edge function ──────────────────────────────────────
create or replace function private.call_edge_function(
  fn_name  text,
  payload  jsonb
) returns void language plpgsql security definer as $$
declare
  base_url text := current_setting('app.supabase_url', true);
  anon_key text := current_setting('app.supabase_anon_key', true);
begin
  perform extensions.http_post(
    url     := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body    := payload::text
  );
exception when others then
  -- Log but never block the original transaction
  raise warning '[webhook] call to % failed: %', fn_name, sqlerrm;
end;
$$;

-- Fallback: some Supabase versions expose net.http_post instead of http_post
-- The block below tries the net schema variant if the extensions one is absent.
create or replace function private.call_edge_function_net(
  fn_name  text,
  payload  jsonb
) returns void language plpgsql security definer as $$
declare
  base_url text := 'https://ulzijveryrnfthschghw.supabase.co';
  anon_key text :=
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    || '.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsemlqdmVyeXJuZnRoc2NoZ2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTA4MjcsImV4cCI6MjA5NjA2NjgyN30'
    || '.NIN2T5Rff2YGfpe0r5JqLewW6C5ablzzcguXdZjTZ7U';
begin
  perform net.http_post(
    url     := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body    := payload::text
  );
exception when others then
  raise warning '[webhook] net.http_post to % failed: %', fn_name, sqlerrm;
end;
$$;

-- ─── 1. trigger-builder — INSERT on clients where status = 'new' ───────────
create or replace function private.on_client_insert()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'new' then
    perform net.http_post(
      url     := 'https://ulzijveryrnfthschghw.supabase.co/functions/v1/trigger-builder',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsemlqdmVyeXJuZnRoc2NoZ2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTA4MjcsImV4cCI6MjA5NjA2NjgyN30.NIN2T5Rff2YGfpe0r5JqLewW6C5ablzzcguXdZjTZ7U'
      ),
      body    := jsonb_build_object(
        'type',   'INSERT',
        'table',  'clients',
        'schema', 'public',
        'record', row_to_json(new)::jsonb
      )::text
    );
  end if;
  return new;
exception when others then
  raise warning '[on_client_insert] edge function call failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_client_insert on public.clients;
create trigger on_client_insert
  after insert on public.clients
  for each row execute function private.on_client_insert();

-- ─── 2. trigger-auditor — UPDATE on clients where new status = 'auditing' ──
create or replace function private.on_client_update_auditing()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'auditing' and old.status <> 'auditing' then
    perform net.http_post(
      url     := 'https://ulzijveryrnfthschghw.supabase.co/functions/v1/trigger-auditor',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsemlqdmVyeXJuZnRoc2NoZ2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTA4MjcsImV4cCI6MjA5NjA2NjgyN30.NIN2T5Rff2YGfpe0r5JqLewW6C5ablzzcguXdZjTZ7U'
      ),
      body    := jsonb_build_object(
        'type',       'UPDATE',
        'table',      'clients',
        'schema',     'public',
        'record',     row_to_json(new)::jsonb,
        'old_record', row_to_json(old)::jsonb
      )::text
    );
  end if;
  return new;
exception when others then
  raise warning '[on_client_update_auditing] edge function call failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_client_update_auditing on public.clients;
create trigger on_client_update_auditing
  after update on public.clients
  for each row execute function private.on_client_update_auditing();

-- ─── 3. trigger-qa — UPDATE on clients where new status = 'qa' ─────────────
create or replace function private.on_client_update_qa()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'qa' and old.status <> 'qa' then
    perform net.http_post(
      url     := 'https://ulzijveryrnfthschghw.supabase.co/functions/v1/trigger-qa',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsemlqdmVyeXJuZnRoc2NoZ2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTA4MjcsImV4cCI6MjA5NjA2NjgyN30.NIN2T5Rff2YGfpe0r5JqLewW6C5ablzzcguXdZjTZ7U'
      ),
      body    := jsonb_build_object(
        'type',       'UPDATE',
        'table',      'clients',
        'schema',     'public',
        'record',     row_to_json(new)::jsonb,
        'old_record', row_to_json(old)::jsonb
      )::text
    );
  end if;
  return new;
exception when others then
  raise warning '[on_client_update_qa] edge function call failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_client_update_qa on public.clients;
create trigger on_client_update_qa
  after update on public.clients
  for each row execute function private.on_client_update_qa();
