alter table public.cdks add column code_plain text;
create index cdks_email_idx on public.cdks (lower(email));

create or replace function public.enforce_cdk_one_way() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.code_hash is distinct from old.code_hash then raise exception 'CDK_HASH_IMMUTABLE'; end if;
  if new.code_plain is distinct from old.code_plain then raise exception 'CDK_PLAINTEXT_IMMUTABLE'; end if;
  if old.status = 'used' and new.status <> 'used' then raise exception 'CDK_CANNOT_RETURN_UNUSED'; end if;
  if old.status = 'used' and (new.email is distinct from old.email or new.used_at is distinct from old.used_at or new.workspace_id is distinct from old.workspace_id) then raise exception 'CDK_USAGE_SNAPSHOT_IMMUTABLE'; end if;
  if old.result is distinct from new.result and old.result is not null and old.result <> 'processing' then raise exception 'CDK_RESULT_FINAL'; end if;
  return new;
end;
$$;

grant insert (code_hash, code_plain) on table public.cdks to service_role;
