-- Agente de monitoramento dos portais de imprensa serranos.
-- Edge Function portal-news-monitor + pg_cron, no padrão do coletor
-- B2/Windsor (ver windsor-instagram-setup.sql).
--
-- Arquitetura:
--   pg_cron (1x por hora) --http--> Edge Function portal-news-monitor
--      --> lê o RSS de cada portal (entity_type='portal' em monitored_entities)
--      --> filtra por pautas (Ricardo Lima / direita serrana)
--      --> insert em public.mentions (source='portal_rss'), dedupe por url
--   O estado de cada feed (URL descoberta, último erro) fica em portal_feeds.
--
-- Só monitoramento: sem análise de sentimento/IA (sentiment fica null nas
-- menções gravadas por este agente). Rodar 1x/hora sobre os 17 portais é
-- barato o bastante para cobrir todos numa passada só (PORTAL_MONITOR_BATCH=20).
--
-- Divisão de trabalho com o news collector do n8n:
--   n8n     — descoberta ampla: candidato e adversários em qualquer fonte.
--   este    — profundidade nos veículos serranos, via feed, sem custo de API.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Estado por portal (já aplicado na migration create_portal_feeds).
--    Guardado aqui como referência do schema:
--
--  create table public.portal_feeds (
--    entity_id uuid primary key references public.monitored_entities(id) on delete cascade,
--    feed_url text,
--    feed_status text not null default 'unknown',  -- ok | none | error
--    last_checked_at timestamptz,
--    last_error text,
--    created_at timestamptz not null default now()
--  );

-- 2) Agendamento. Minuto 10 para não colidir com o windsor-instagram (minuto
--    0). Com PORTAL_MONITOR_BATCH=20 (> 17 portais cadastrados), toda a lista
--    é revisitada em cada execução.
select cron.unschedule('portal-news-monitor-30min')
where exists (select 1 from cron.job where jobname = 'portal-news-monitor-30min');
select cron.unschedule('portal-news-monitor-hourly')
where exists (select 1 from cron.job where jobname = 'portal-news-monitor-hourly');

select cron.schedule(
  'portal-news-monitor-hourly',
  '10 * * * *',
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/portal-news-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'portal_monitor_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $$
);

-- Secrets a configurar fora daqui:
--   Vault:  select vault.create_secret('<valor>', 'portal_monitor_cron_secret', 'cron portal-news-monitor');
--   Edge Functions → Secrets:
--     PORTAL_CRON_SECRET   — mesmo valor do portal_monitor_cron_secret. Nome
--                            diferente de propósito: secrets de Edge Function
--                            são globais no projeto, e windsor-instagram já
--                            usa CRON_SECRET — reaproveitar sobrescreveria.
--     PORTAL_MONITOR_BATCH — opcional, default 20

-- Diagnóstico:
--   -- estado dos feeds (quais portais não têm RSS):
--   select e.name, f.feed_status, f.feed_url, f.last_checked_at, f.last_error
--     from public.monitored_entities e
--     left join public.portal_feeds f on f.entity_id = e.id
--    where e.entity_type = 'portal' and e.is_active
--    order by f.feed_status nulls first, e.name;
--   -- matérias coletadas por este agente (sem sentimento: campo sempre null):
--   select published_at, metadata->>'source_name' portal,
--          metadata->'matched_terms' termos, title
--     from public.mentions where source = 'portal_rss'
--    order by published_at desc limit 50;
--   select * from cron.job_run_details where jobid =
--     (select jobid from cron.job where jobname='portal-news-monitor-hourly')
--     order by start_time desc limit 10;
