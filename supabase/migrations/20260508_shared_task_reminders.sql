-- Add shared task reminder payloads so every member device can schedule the
-- same shared-list reminder locally.

alter table public.tri_shared_items
  add column if not exists reminder jsonb;

create or replace function public.tri_create_shared_list(
  p_kind text,
  p_name text,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := public.tri_uid();
  v_email text := coalesce(auth.jwt()->>'email', '');
  v_initial text := upper(substr(nullif(v_email, ''), 1, 1));
  v_code text;
  v_list public.tri_shared_lists;
  v_item jsonb;
  v_item_row public.tri_shared_items;
  v_items jsonb := '[]'::jsonb;
begin
  if not public.tri_is_triority_firebase_jwt() then
    raise exception 'Not signed in';
  end if;
  if p_kind not in ('tasks', 'grocery') then
    raise exception 'Invalid shared list kind';
  end if;
  if p_kind = 'grocery' and public.tri_member_kind_count('grocery') >= 1 then
    raise exception 'You are already in a shared grocery list';
  end if;
  if p_kind = 'tasks' and public.tri_member_kind_count('tasks') >= 5 then
    raise exception 'You have reached the shared task list limit';
  end if;

  loop
    v_code := public.tri_random_share_code();
    exit when not exists (select 1 from public.tri_shared_lists where share_code = v_code);
  end loop;

  insert into public.tri_shared_lists(owner_uid, kind, name, share_code)
  values (v_uid, p_kind, coalesce(nullif(trim(p_name), ''), case when p_kind = 'grocery' then 'Groceries' else 'Shared List' end), v_code)
  returning * into v_list;

  insert into public.tri_shared_members(list_id, uid, email_initial, avatar_slot)
  values (v_list.id, v_uid, coalesce(nullif(v_initial, ''), '?'), 0);

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.tri_shared_items(
      list_id,
      text,
      tier,
      reminder,
      name,
      category,
      checked,
      created_by,
      created_at,
      last_edited_by,
      last_edited_at
    )
    values (
      v_list.id,
      nullif(v_item->>'text', ''),
      nullif(v_item->>'tier', ''),
      case when v_item ? 'reminder' then v_item->'reminder' else null end,
      nullif(v_item->>'name', ''),
      nullif(v_item->>'category', ''),
      coalesce((v_item->>'checked')::boolean, false),
      v_uid,
      to_timestamp(coalesce((v_item->>'createdAt')::double precision, extract(epoch from now()) * 1000) / 1000),
      v_uid,
      now()
    )
    returning * into v_item_row;

    v_items := v_items || jsonb_build_object(
      'id', v_item_row.id,
      'text', v_item_row.text,
      'tier', v_item_row.tier,
      'reminder', v_item_row.reminder,
      'name', v_item_row.name,
      'category', v_item_row.category,
      'checked', v_item_row.checked,
      'createdBy', v_item_row.created_by,
      'createdAt', floor(extract(epoch from v_item_row.created_at) * 1000),
      'lastEditedBy', v_item_row.last_edited_by,
      'lastEditedAt', floor(extract(epoch from v_item_row.last_edited_at) * 1000)
    );
  end loop;

  return jsonb_build_object(
    'list', jsonb_build_object(
      'id', v_list.id,
      'ownerUid', v_list.owner_uid,
      'kind', v_list.kind,
      'name', v_list.name,
      'shareCode', v_list.share_code,
      'createdAt', floor(extract(epoch from v_list.created_at) * 1000),
      'updatedAt', floor(extract(epoch from v_list.updated_at) * 1000)
    ),
    'items', v_items
  );
end;
$$;
