-- Tzurah production DB index readiness
-- Safe to copy into the Supabase SQL editor.
--
-- Rules:
-- - Additive indexes only.
-- - No data mutation.
-- - No table drops.
-- - Optional tables/columns are checked before each index is created.
-- - Run during a low-traffic maintenance window.

do $$
begin
  if to_regclass('public.sessions') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='session_id') then
      execute 'create unique index if not exists idx_sessions_session_id on public.sessions(session_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='user_id') then
      execute 'create index if not exists idx_sessions_user_id on public.sessions(user_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='is_active') then
      execute 'create index if not exists idx_sessions_is_active on public.sessions(is_active)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='updated_at') then
      execute 'create index if not exists idx_sessions_updated_at on public.sessions(updated_at)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='last_ping') then
      execute 'create index if not exists idx_sessions_last_ping on public.sessions(last_ping)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='user_id')
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='is_active') then
      execute 'create index if not exists idx_sessions_user_active on public.sessions(user_id, is_active)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='is_active')
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='last_ping') then
      execute 'create index if not exists idx_sessions_last_ping_active on public.sessions(is_active, last_ping)';
    end if;
  end if;

  if to_regclass('public.billing_syncs') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_syncs' and column_name='session_id') then
      execute 'create index if not exists idx_billing_syncs_session_id on public.billing_syncs(session_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_syncs' and column_name='user_id') then
      execute 'create index if not exists idx_billing_syncs_user_id on public.billing_syncs(user_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_syncs' and column_name='sync_id') then
      execute 'create unique index if not exists idx_billing_syncs_sync_id on public.billing_syncs(sync_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_syncs' and column_name='created_at') then
      execute 'create index if not exists idx_billing_syncs_created_at on public.billing_syncs(created_at)';
    end if;
  end if;

  if to_regclass('public.billing_reconciliation_events') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_reconciliation_events' and column_name='type') then
      execute 'create index if not exists idx_billing_recon_type on public.billing_reconciliation_events(type)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_reconciliation_events' and column_name='severity') then
      execute 'create index if not exists idx_billing_recon_severity on public.billing_reconciliation_events(severity)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_reconciliation_events' and column_name='status') then
      execute 'create index if not exists idx_billing_recon_status on public.billing_reconciliation_events(status)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_reconciliation_events' and column_name='resolved') then
      execute 'create index if not exists idx_billing_recon_resolved on public.billing_reconciliation_events(resolved)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_reconciliation_events' and column_name='created_at') then
      execute 'create index if not exists idx_billing_recon_created_at on public.billing_reconciliation_events(created_at)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='billing_reconciliation_events' and column_name='session_id') then
      execute 'create index if not exists idx_billing_recon_session_id on public.billing_reconciliation_events(session_id)';
    end if;
  end if;

  if to_regclass('public.decart_deductions') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='decart_deductions' and column_name='session_id') then
      execute 'create index if not exists idx_decart_deductions_session_id on public.decart_deductions(session_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='decart_deductions' and column_name='user_id') then
      execute 'create index if not exists idx_decart_deductions_user_id on public.decart_deductions(user_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='decart_deductions' and column_name='created_at') then
      execute 'create index if not exists idx_decart_deductions_created_at on public.decart_deductions(created_at)';
    end if;
  end if;

  if to_regclass('public.profiles') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='email') then
      execute 'create index if not exists idx_profiles_email on public.profiles(email)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='status') then
      execute 'create index if not exists idx_profiles_status on public.profiles(status)';
    end if;
  end if;

  if to_regclass('public.app_settings') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_settings' and column_name='key') then
    execute 'create unique index if not exists idx_app_settings_key on public.app_settings(key)';
  end if;

  if to_regclass('public.purchases') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='purchases' and column_name='user_id') then
      execute 'create index if not exists idx_purchases_user_id on public.purchases(user_id)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='purchases' and column_name='created_at') then
      execute 'create index if not exists idx_purchases_created_at on public.purchases(created_at)';
    end if;
  end if;

  if to_regclass('public.admin_actions') is not null then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_actions' and column_name='created_at') then
      execute 'create index if not exists idx_admin_actions_created_at on public.admin_actions(created_at)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_actions' and column_name='action') then
      execute 'create index if not exists idx_admin_actions_action on public.admin_actions(action)';
    end if;
  end if;

  -- Payment scaffold tables are not created by this task. If later applied,
  -- add their indexes in the payment migration that creates those tables.
end $$;

-- Verification query:
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'sessions',
    'billing_syncs',
    'billing_reconciliation_events',
    'decart_deductions',
    'profiles',
    'app_settings',
    'purchases',
    'admin_actions'
  )
order by tablename, indexname;
