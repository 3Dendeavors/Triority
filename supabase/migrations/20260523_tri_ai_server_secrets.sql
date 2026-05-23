create table if not exists public.tri_ai_server_secrets (
  name text primary key,
  secret_value text not null,
  updated_at timestamptz not null default now()
);

alter table public.tri_ai_server_secrets enable row level security;

revoke all on table public.tri_ai_server_secrets from anon, authenticated;
