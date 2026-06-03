-- MoeBuilds pipeline webhook triggers
--
-- Uses pg_net (pre-installed on all Supabase projects) to POST to the three
-- Supabase Edge Functions whenever a client row moves through the pipeline.
--
-- Apply with:  supabase db push  (or paste into the Supabase SQL editor)

-- pg_net is pre-installed on Supabase — no schema clause needed
create extension if not exists pg_net;

-- private schema for internal trigger functions (not exposed via PostgREST)
create schema if not exists private;

-- ─── 1. trigger-builder — fires after INSERT where status = 'new' ──────────
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
  raise warning '[on_client_insert] webhook failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_client_insert on public.clients;
create trigger on_client_insert
  after insert on public.clients
  for each row execute function private.on_client_insert();

-- ─── 2. trigger-auditor — fires after UPDATE where status becomes 'auditing' ─
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
  raise warning '[on_client_update_auditing] webhook failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_client_update_auditing on public.clients;
create trigger on_client_update_auditing
  after update on public.clients
  for each row execute function private.on_client_update_auditing();

-- ─── 3. trigger-qa — fires after UPDATE where status becomes 'qa' ──────────
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
  raise warning '[on_client_update_qa] webhook failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_client_update_qa on public.clients;
create trigger on_client_update_qa
  after update on public.clients
  for each row execute function private.on_client_update_qa();
