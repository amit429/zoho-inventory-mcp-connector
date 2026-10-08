-- Zoho Inventory connector schema.
--
-- Access model:
--   * Merchants sign in with Supabase Auth and can READ their own connections,
--     API key metadata and usage logs through RLS.
--   * Every WRITE, and every read of secrets (tokens, key hashes, OAuth state,
--     rate-limit buckets), goes through the server using the secret key, which
--     bypasses RLS. Those tables have RLS enabled and no policies, so they are
--     unreachable from the browser.

-- ---------------------------------------------------------------------------
-- connections: one row per (merchant, Zoho organization)
-- ---------------------------------------------------------------------------
create table public.connections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  provider        text not null default 'zoho_inventory',
  zoho_org_id     text not null,
  zoho_org_name   text,
  currency_code   text,
  time_zone       text,
  accounts_server text not null,          -- e.g. https://accounts.zoho.in
  api_domain      text not null,          -- e.g. https://www.zohoapis.in
  scopes          text[] not null default '{}',
  status          text not null default 'active'
                  check (status in ('active', 'needs_reauth', 'revoked')),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, zoho_org_id)
);

create index connections_user_id_idx on public.connections (user_id);

-- ---------------------------------------------------------------------------
-- oauth_tokens: Zoho tokens, AES-256-GCM encrypted by the app before insert.
-- refresh_lock_until is a lease so only one serverless instance refreshes.
-- ---------------------------------------------------------------------------
create table public.oauth_tokens (
  connection_id      uuid primary key references public.connections (id) on delete cascade,
  access_token_enc   text not null,
  refresh_token_enc  text not null,
  expires_at         timestamptz not null,
  refresh_lock_until timestamptz,
  refreshed_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- api_keys: how an agent authenticates to /api/mcp. Only a SHA-256 hash is
-- stored; the plaintext key is shown to the merchant once.
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections (id) on delete cascade,
  name          text not null,
  key_prefix    text not null,              -- first chars, for display only
  key_hash      text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index api_keys_connection_id_idx on public.api_keys (connection_id);

-- ---------------------------------------------------------------------------
-- oauth_states: one-time CSRF state for the Zoho consent round trip.
-- ---------------------------------------------------------------------------
create table public.oauth_states (
  state           text primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  accounts_server text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '10 minutes'
);

create index oauth_states_user_id_idx on public.oauth_states (user_id);

-- ---------------------------------------------------------------------------
-- rate_limit_buckets: token buckets shared by every serverless instance.
-- Keyed per Zoho organization, because that is how Zoho enforces its limit.
-- ---------------------------------------------------------------------------
create table public.rate_limit_buckets (
  bucket_key text primary key,
  tokens     double precision not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tool_calls: one row per MCP tool invocation, for the usage dashboard.
-- Arguments are deliberately not stored (they can contain customer PII).
-- ---------------------------------------------------------------------------
create table public.tool_calls (
  id            bigint generated always as identity primary key,
  connection_id uuid not null references public.connections (id) on delete cascade,
  api_key_id    uuid references public.api_keys (id) on delete set null,
  tool          text not null,
  status        text not null check (status in ('ok', 'error')),
  error_code    text,
  latency_ms    integer not null,
  zoho_requests integer not null default 0,
  created_at    timestamptz not null default now()
);

create index tool_calls_connection_created_idx on public.tool_calls (connection_id, created_at desc);
create index tool_calls_api_key_id_idx on public.tool_calls (api_key_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.connections        enable row level security;
alter table public.oauth_tokens       enable row level security;
alter table public.api_keys           enable row level security;
alter table public.oauth_states       enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.tool_calls         enable row level security;

create policy "owners read their connections" on public.connections
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "owners read their api key metadata" on public.api_keys
  for select to authenticated
  using (exists (
    select 1 from public.connections c
    where c.id = api_keys.connection_id and c.user_id = (select auth.uid())
  ));

create policy "owners read their tool calls" on public.tool_calls
  for select to authenticated
  using (exists (
    select 1 from public.connections c
    where c.id = tool_calls.connection_id and c.user_id = (select auth.uid())
  ));

-- key_hash is server-only even for the owner: a column-level revoke is a no-op
-- while a table-level grant exists, so grant only the safe columns instead.
revoke select on public.api_keys from authenticated, anon;
grant select (id, connection_id, name, key_prefix, created_at, last_used_at, revoked_at)
  on public.api_keys to authenticated;

-- ---------------------------------------------------------------------------
-- take_rate_limit_token: atomic token bucket.
-- Returns allowed=true and consumes a token, or allowed=false and how long
-- to wait until one token is available.
-- ---------------------------------------------------------------------------
create or replace function public.take_rate_limit_token(
  p_bucket_key     text,
  p_capacity       integer,
  p_refill_per_sec double precision
)
returns table (allowed boolean, retry_after_ms integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tokens  double precision;
  v_updated timestamptz;
  v_now     timestamptz := clock_timestamp();
begin
  insert into public.rate_limit_buckets (bucket_key, tokens, updated_at)
  values (p_bucket_key, p_capacity, v_now)
  on conflict (bucket_key) do nothing;

  select b.tokens, b.updated_at into v_tokens, v_updated
  from public.rate_limit_buckets b
  where b.bucket_key = p_bucket_key
  for update;

  v_tokens := least(
    p_capacity::double precision,
    v_tokens + extract(epoch from (v_now - v_updated)) * p_refill_per_sec
  );

  if v_tokens >= 1 then
    update public.rate_limit_buckets
    set tokens = v_tokens - 1, updated_at = v_now
    where bucket_key = p_bucket_key;
    return query select true, 0;
  else
    update public.rate_limit_buckets
    set tokens = v_tokens, updated_at = v_now
    where bucket_key = p_bucket_key;
    return query select false, ceil((1 - v_tokens) / p_refill_per_sec * 1000)::integer;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- acquire_refresh_lock: lease-based lock so concurrent instances don't all
-- spend Zoho's per-refresh-token quota at once. Returns true if acquired.
-- ---------------------------------------------------------------------------
create or replace function public.acquire_refresh_lock(
  p_connection_id uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.oauth_tokens
  set refresh_lock_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
  where connection_id = p_connection_id
    and (refresh_lock_until is null or refresh_lock_until < clock_timestamp());
  return found;
end;
$$;

-- These functions mutate server-only tables; only the server may call them.
revoke execute on function public.take_rate_limit_token(text, integer, double precision) from public, anon, authenticated;
revoke execute on function public.acquire_refresh_lock(uuid, integer) from public, anon, authenticated;
grant execute on function public.take_rate_limit_token(text, integer, double precision) to service_role;
grant execute on function public.acquire_refresh_lock(uuid, integer) to service_role;
