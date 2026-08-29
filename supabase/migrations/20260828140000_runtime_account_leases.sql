-- Runtime ownership is independent from account type and shard assignment.
-- The retained fencing token makes a stale process unable to renew or release a
-- lease after another process has taken over the same Telegram account.

create or replace function public.acquire_account_lease(
  p_account_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer
)
returns table (
  result_status text,
  account_id uuid,
  lease_owner uuid,
  fencing_token bigint,
  lease_until timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  lease_row public.account_leases%rowtype;
begin
  if p_lease_seconds not between 1 and 3600 then
    raise exception using errcode = 'P0001', message = 'INVALID_LEASE_DURATION';
  end if;
  if not exists (select 1 from public.telegram_accounts where id = p_account_id) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_NOT_FOUND';
  end if;

  loop
    select * into lease_row from public.account_leases
     where account_leases.account_id = p_account_id for update;
    if not found then
      begin
        insert into public.account_leases (account_id, lease_owner, fencing_token, lease_until)
        values (p_account_id, p_lease_owner, 1, now() + make_interval(secs => p_lease_seconds))
        returning * into lease_row;
        return query select 'ACQUIRED'::text, lease_row.account_id, lease_row.lease_owner, lease_row.fencing_token, lease_row.lease_until;
        return;
      exception when unique_violation then
        -- Another process inserted first; lock and inspect its row on the next loop.
      end;
    elsif lease_row.lease_owner = p_lease_owner and lease_row.lease_until > now() then
      update public.account_leases
         set lease_until = now() + make_interval(secs => p_lease_seconds)
       where account_leases.account_id = p_account_id
       returning * into lease_row;
      return query select 'RENEWED'::text, lease_row.account_id, lease_row.lease_owner, lease_row.fencing_token, lease_row.lease_until;
      return;
    elsif lease_row.lease_until <= now() then
      update public.account_leases
         set lease_owner = p_lease_owner,
             fencing_token = lease_row.fencing_token + 1,
             lease_until = now() + make_interval(secs => p_lease_seconds)
       where account_leases.account_id = p_account_id
       returning * into lease_row;
      return query select 'TAKEN_OVER'::text, lease_row.account_id, lease_row.lease_owner, lease_row.fencing_token, lease_row.lease_until;
      return;
    else
      return query select 'HELD_BY_OTHER'::text, lease_row.account_id, lease_row.lease_owner, lease_row.fencing_token, lease_row.lease_until;
      return;
    end if;
  end loop;
end;
$$;

create or replace function public.renew_account_lease(
  p_account_id uuid,
  p_lease_owner uuid,
  p_fencing_token bigint,
  p_lease_seconds integer
)
returns table (account_id uuid, lease_owner uuid, fencing_token bigint, lease_until timestamptz)
language plpgsql
set search_path = public
as $$
begin
  if p_lease_seconds not between 1 and 3600 then
    raise exception using errcode = 'P0001', message = 'INVALID_LEASE_DURATION';
  end if;
  return query
  update public.account_leases
     set lease_until = now() + make_interval(secs => p_lease_seconds)
   where account_leases.account_id = p_account_id
     and account_leases.lease_owner = p_lease_owner
     and account_leases.fencing_token = p_fencing_token
     and account_leases.lease_until > now()
  returning account_leases.account_id, account_leases.lease_owner,
            account_leases.fencing_token, account_leases.lease_until;
end;
$$;

create or replace function public.release_account_lease(
  p_account_id uuid,
  p_lease_owner uuid,
  p_fencing_token bigint
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  released boolean;
begin
  update public.account_leases
     set lease_until = now()
   where account_leases.account_id = p_account_id
     and account_leases.lease_owner = p_lease_owner
     and account_leases.fencing_token = p_fencing_token
     and account_leases.lease_until > now()
  returning true into released;
  return coalesce(released, false);
end;
$$;

comment on function public.acquire_account_lease(uuid, uuid, integer)
  is 'Acquires or renews a runtime lease for either a Userbot or JASEB worker. Token increases on every takeover.';
comment on function public.renew_account_lease(uuid, uuid, bigint, integer)
  is 'Renews only an unexpired lease held by the current fencing token.';
comment on function public.release_account_lease(uuid, uuid, bigint)
  is 'Expires only the exact current lease; it intentionally retains the fencing token.';

revoke all on function public.acquire_account_lease(uuid, uuid, integer) from public;
revoke all on function public.renew_account_lease(uuid, uuid, bigint, integer) from public;
revoke all on function public.release_account_lease(uuid, uuid, bigint) from public;
