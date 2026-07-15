create or replace function public.delete_removable_cdks(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare deleted integer;
begin
  delete from public.cdks c
  where (p_ids is null or c.id = any(p_ids))
    and (c.status = 'unused' or (c.status = 'used' and c.result in
      ('join_rejected','accept_not_found','worker_unavailable','upstream_timeout','internal_error','service_interrupted')));
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
revoke all on function public.delete_removable_cdks(uuid[]) from public, anon, authenticated;
grant execute on function public.delete_removable_cdks(uuid[]) to service_role;
