-- take_rate_limit_token v2: never queue behind another caller's row lock.
--
-- Load testing (40 parallel callers) showed every RPC taking ~3s instead of
-- ~80ms, so tool calls blew through the client's 8s wait budget. The queue was
-- v1's unconditional `insert ... on conflict do nothing`: when the existing
-- row has an uncommitted update, Postgres makes the insert wait for that
-- transaction to decide whether it conflicts, serializing every caller.
--
-- v2 locks with SKIP LOCKED first and only inserts if the bucket truly doesn't
-- exist (checked with a plain MVCC read, which never blocks). A caller that
-- finds the row busy is told to retry shortly; the client sleeps with jitter
-- and keeps its deadline.

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
  select b.tokens, b.updated_at into v_tokens, v_updated
  from public.rate_limit_buckets b
  where b.bucket_key = p_bucket_key
  for update skip locked;

  if not found then
    if exists (select 1 from public.rate_limit_buckets b where b.bucket_key = p_bucket_key) then
      -- Another caller holds the bucket right now; come back shortly.
      return query select false, 250;
      return;
    end if;

    -- First request for this bucket.
    insert into public.rate_limit_buckets (bucket_key, tokens, updated_at)
    values (p_bucket_key, p_capacity, v_now)
    on conflict (bucket_key) do nothing;

    select b.tokens, b.updated_at into v_tokens, v_updated
    from public.rate_limit_buckets b
    where b.bucket_key = p_bucket_key
    for update skip locked;

    if not found then
      return query select false, 250;
      return;
    end if;
  end if;

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

revoke execute on function public.take_rate_limit_token(text, integer, double precision) from public, anon, authenticated;
grant execute on function public.take_rate_limit_token(text, integer, double precision) to service_role;
