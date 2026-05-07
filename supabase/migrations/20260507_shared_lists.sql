-- Triority shared-list backend, phase 1.
-- Run this in Supabase SQL Editor after enabling Authentication > Third-party Auth > Firebase.
-- Firebase project id: triority-4649d

create extension if not exists pgcrypto;

create table if not exists public.tri_shared_lists (
  id uuid primary key default gen_random_uuid(),
  owner_uid text not null,
  kind text not null check (kind in ('tasks', 'grocery')),
  name text not null,
  share_code text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tri_shared_members (
  list_id uuid not null references public.tri_shared_lists(id) on delete cascade,
  uid text not null,
  email_initial text not null default '?',
  avatar_slot integer not null default 0,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (list_id, uid)
);

create table if not exists public.tri_shared_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.tri_shared_lists(id) on delete cascade,
  text text,
  tier text check (tier in ('high', 'medium', 'low') or tier is null),
  name text,
  category text,
  checked boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_edited_by text not null,
  last_edited_at timestamptz not null default now()
);

create table if not exists public.tri_shared_archives (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.tri_shared_lists(id) on delete cascade,
  text text not null,
  tier text not null check (tier in ('high', 'medium', 'low')),
  completed_at timestamptz not null default now(),
  archived_by text not null,
  created_at timestamptz,
  last_edited_by text,
  last_edited_at timestamptz
);

create index if not exists tri_shared_lists_share_code_idx on public.tri_shared_lists(share_code);
create index if not exists tri_shared_members_uid_idx on public.tri_shared_members(uid);
create index if not exists tri_shared_items_list_id_idx on public.tri_shared_items(list_id);
create index if not exists tri_shared_archives_list_id_idx on public.tri_shared_archives(list_id);

create or replace function public.tri_uid()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt()->>'sub', '');
$$;

create or replace function public.tri_is_triority_firebase_jwt()
returns boolean
language sql
stable
as $$
  select
    auth.jwt() is not null
    and auth.jwt()->>'iss' = 'https://securetoken.google.com/triority-4649d'
    and auth.jwt()->>'aud' = 'triority-4649d'
    and coalesce(auth.jwt()->>'sub', '') <> '';
$$;

create or replace function public.tri_is_shared_member(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tri_shared_members m
    where m.list_id = p_list_id
      and m.uid = public.tri_uid()
  );
$$;

create or replace function public.tri_random_share_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRTUVWXY3469';
  code text := '';
  i integer;
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;
  return code;
end;
$$;

create or replace function public.tri_next_avatar_slot(p_list_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with slots(slot) as (
    values (0),(1),(2),(3),(4),(5),(6),(7)
  )
  select coalesce(
    (
      select s.slot
      from slots s
      where not exists (
        select 1
        from public.tri_shared_members m
        where m.list_id = p_list_id
          and m.avatar_slot = s.slot
      )
      order by s.slot
      limit 1
    ),
    0
  );
$$;

create or replace function public.tri_member_kind_count(p_kind text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.tri_shared_members m
  join public.tri_shared_lists l on l.id = m.list_id
  where m.uid = public.tri_uid()
    and l.kind = p_kind;
$$;

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

create or replace function public.tri_join_shared_list(p_share_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := public.tri_uid();
  v_email text := coalesce(auth.jwt()->>'email', '');
  v_initial text := upper(substr(nullif(v_email, ''), 1, 1));
  v_list public.tri_shared_lists;
  v_slot integer;
begin
  if not public.tri_is_triority_firebase_jwt() then
    raise exception 'Not signed in';
  end if;

  select *
  into v_list
  from public.tri_shared_lists
  where share_code = upper(regexp_replace(coalesce(p_share_code, ''), '[^A-Za-z0-9]', '', 'g'))
  limit 1;

  if v_list.id is null then
    raise exception 'Code not found';
  end if;

  if not exists (select 1 from public.tri_shared_members where list_id = v_list.id and uid = v_uid) then
    if v_list.kind = 'grocery' and public.tri_member_kind_count('grocery') >= 1 then
      raise exception 'You are already in a shared grocery list';
    end if;
    if v_list.kind = 'tasks' and public.tri_member_kind_count('tasks') >= 5 then
      raise exception 'You have reached the shared task list limit';
    end if;
    v_slot := public.tri_next_avatar_slot(v_list.id);
    insert into public.tri_shared_members(list_id, uid, email_initial, avatar_slot)
    values (v_list.id, v_uid, coalesce(nullif(v_initial, ''), '?'), v_slot);
  end if;

  return jsonb_build_object(
    'id', v_list.id,
    'ownerUid', v_list.owner_uid,
    'kind', v_list.kind,
    'name', v_list.name,
    'shareCode', v_list.share_code,
    'createdAt', floor(extract(epoch from v_list.created_at) * 1000),
    'updatedAt', floor(extract(epoch from v_list.updated_at) * 1000)
  );
end;
$$;

create or replace function public.tri_delete_shared_list(p_list_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := public.tri_uid();
begin
  if not public.tri_is_triority_firebase_jwt() then
    raise exception 'Not signed in';
  end if;

  delete from public.tri_shared_lists
  where id = p_list_id
    and owner_uid = v_uid;

  if not found then
    raise exception 'Only the owner can delete this list';
  end if;

  return true;
end;
$$;

create or replace function public.tri_leave_shared_list(p_list_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := public.tri_uid();
  v_owner text;
begin
  if not public.tri_is_triority_firebase_jwt() then
    raise exception 'Not signed in';
  end if;

  select owner_uid into v_owner
  from public.tri_shared_lists
  where id = p_list_id;

  if v_owner is null then
    return true;
  end if;
  if v_owner = v_uid then
    raise exception 'Owner cannot leave. Delete the list instead.';
  end if;

  delete from public.tri_shared_members
  where list_id = p_list_id
    and uid = v_uid;

  update public.tri_shared_lists
  set updated_at = now()
  where id = p_list_id;

  return true;
end;
$$;

create or replace function public.tri_rename_shared_list(p_list_id uuid, p_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.tri_is_triority_firebase_jwt() then
    raise exception 'Not signed in';
  end if;
  if not public.tri_is_shared_member(p_list_id) then
    raise exception 'Not a member of this list';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Name required';
  end if;

  update public.tri_shared_lists
  set name = trim(p_name),
      updated_at = now()
  where id = p_list_id;

  return true;
end;
$$;

create or replace function public.tri_rotate_share_code(p_list_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := public.tri_uid();
  v_code text;
begin
  if not public.tri_is_triority_firebase_jwt() then
    raise exception 'Not signed in';
  end if;
  if not exists (
    select 1
    from public.tri_shared_lists
    where id = p_list_id
      and owner_uid = v_uid
  ) then
    raise exception 'Only the owner can rotate the code';
  end if;

  loop
    v_code := public.tri_random_share_code();
    exit when not exists (select 1 from public.tri_shared_lists where share_code = v_code);
  end loop;

  update public.tri_shared_lists
  set share_code = v_code,
      updated_at = now()
  where id = p_list_id;

  return v_code;
end;
$$;

alter table public.tri_shared_lists enable row level security;
alter table public.tri_shared_members enable row level security;
alter table public.tri_shared_items enable row level security;
alter table public.tri_shared_archives enable row level security;

drop policy if exists tri_shared_lists_member_select on public.tri_shared_lists;
create policy tri_shared_lists_member_select
  on public.tri_shared_lists
  for select
  to anon, authenticated
  using (public.tri_is_triority_firebase_jwt() and public.tri_is_shared_member(id));

drop policy if exists tri_shared_members_member_select on public.tri_shared_members;
create policy tri_shared_members_member_select
  on public.tri_shared_members
  for select
  to anon, authenticated
  using (public.tri_is_triority_firebase_jwt() and public.tri_is_shared_member(list_id));

drop policy if exists tri_shared_items_member_all on public.tri_shared_items;
create policy tri_shared_items_member_all
  on public.tri_shared_items
  for all
  to anon, authenticated
  using (public.tri_is_triority_firebase_jwt() and public.tri_is_shared_member(list_id))
  with check (public.tri_is_triority_firebase_jwt() and public.tri_is_shared_member(list_id));

drop policy if exists tri_shared_archives_member_all on public.tri_shared_archives;
create policy tri_shared_archives_member_all
  on public.tri_shared_archives
  for all
  to anon, authenticated
  using (public.tri_is_triority_firebase_jwt() and public.tri_is_shared_member(list_id))
  with check (public.tri_is_triority_firebase_jwt() and public.tri_is_shared_member(list_id));

grant usage on schema public to anon, authenticated;
grant select on public.tri_shared_lists to anon, authenticated;
grant select on public.tri_shared_members to anon, authenticated;
grant select, insert, update, delete on public.tri_shared_items to anon, authenticated;
grant select, insert, update, delete on public.tri_shared_archives to anon, authenticated;
grant execute on function public.tri_create_shared_list(text, text, jsonb) to anon, authenticated;
grant execute on function public.tri_join_shared_list(text) to anon, authenticated;
grant execute on function public.tri_delete_shared_list(uuid) to anon, authenticated;
grant execute on function public.tri_leave_shared_list(uuid) to anon, authenticated;
grant execute on function public.tri_rename_shared_list(uuid, text) to anon, authenticated;
grant execute on function public.tri_rotate_share_code(uuid) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tri_shared_lists'
    ) then
      alter publication supabase_realtime add table public.tri_shared_lists;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tri_shared_members'
    ) then
      alter publication supabase_realtime add table public.tri_shared_members;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tri_shared_items'
    ) then
      alter publication supabase_realtime add table public.tri_shared_items;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tri_shared_archives'
    ) then
      alter publication supabase_realtime add table public.tri_shared_archives;
    end if;
  end if;
end $$;
