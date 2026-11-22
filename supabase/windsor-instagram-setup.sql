-- B2 — Coletor de Insights do Instagram (Windsor.ai) via Edge Function + pg_cron.
-- Aplicado no Supabase project SEU_PROJECT_REF. Arquivo de referência
-- (o mesmo SQL já foi executado). Substitui a abordagem n8n por código.
--
-- Arquitetura:
--   pg_cron (de hora em hora) --http--> Edge Function windsor-instagram
--      --> GET connectors.windsor.ai/instagram (insights de conta)
--      --> upsert em intelligence_snapshots (period='instagram', dados em metrics jsonb)
--   Dashboard (index.html) lê via getInstagramInsights() em dashboard.service.js.

-- 1) Extensões: agendador + cliente HTTP assíncrono
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Shared secret usado pelo cron para autenticar na Edge Function (header
--    x-cron-secret == env CRON_SECRET da função). Guardado no Vault.
--    select vault.create_secret('<valor>', 'windsor_cron_secret', 'descrição');

-- 3) Agendamento (minuto 0 de cada hora). O secret é lido do Vault em runtime.
select cron.unschedule('windsor-instagram-hourly')
where exists (select 1 from cron.job where jobname = 'windsor-instagram-hourly');

select cron.schedule(
  'windsor-instagram-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/windsor-instagram',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'windsor_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Secrets da Edge Function (Settings → Edge Functions → Secrets), setados fora daqui:
--   WINDSOR_API_KEY  — chave da API do Windsor.ai
--   CRON_SECRET      — mesmo valor guardado em vault.windsor_cron_secret
--   (WINDSOR_DATE_PRESET opcional; default 'last_7d')

-- Diagnóstico:
--   select * from cron.job where jobname='windsor-instagram-hourly';
--   select * from cron.job_run_details order by start_time desc limit 10;
