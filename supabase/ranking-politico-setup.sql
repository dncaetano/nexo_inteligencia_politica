-- Ranking Político — Scraper de dados públicos de desempenho digital
-- de políticos de Serra Grande. Edge Function + pg_cron (a cada 6h).
--
-- Arquitetura:
--   pg_cron (a cada 6h) --http--> Edge Function ranking-politico-scraper
--      --> GET página pública de ranking político
--      --> upsert em intelligence_snapshots (period='ranking_politico')
--   Frontend lê via getRankingPolitico() em ranking.service.js.

-- 1) Extensões (já devem existir do windsor-instagram)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Agendamento (a cada 6 horas: 00h, 06h, 12h, 18h UTC)
select cron.unschedule('ranking-politico-6h')
where exists (select 1 from cron.job where jobname = 'ranking-politico-6h');

select cron.schedule(
  'ranking-politico-6h',
  '30 */6 * * *',
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/ranking-politico-scraper',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'windsor_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Diagnóstico:
--   select * from cron.job where jobname='ranking-politico-6h';
--   select * from cron.job_run_details where jobid=(select jobid from cron.job where jobname='ranking-politico-6h') order by start_time desc limit 10;
