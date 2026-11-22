-- Coletor de perfis PÚBLICOS dos concorrentes (Windsor.ai) via Edge
-- Function + pg_cron. Aplicado no project SEU_PROJECT_REF —
-- arquivo de referência, o SQL abaixo já foi executado.
--
-- Arquitetura:
--   pg_cron (diário, 06:20 UTC) --http--> Edge Function windsor-instagram-public
--      --> GET connectors.windsor.ai/all
--          com select_accounts=instagram_public__<handle> (11 perfis)
--      --> upsert em intelligence_snapshots (period='instagram_public')
--   Aba Monitoramento (index.html) lê e monta a tabela de Concorrentes.
--
-- Por que period próprio: a função windsor-instagram grava period='instagram'
-- com os Insights PRIVADOS do candidato (reach, impressions, profile views).
-- Se as duas usassem o mesmo period, a coleta pública sobrescreveria os
-- Insights no mesmo dia e a perda seria silenciosa.
--
-- Frequência: diária, e não de hora em hora, porque a janela do Windsor é de
-- 7 dias e o dado só muda de forma relevante uma vez por dia. O crescimento
-- de seguidores é derivado comparando coletas de dias distintos, então a
-- coluna Crescimento só passa a ter valor a partir da SEGUNDA coleta.

-- 1) Extensões (já criadas pelo setup da windsor-instagram)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Agendamento. Reaproveita o mesmo vault.windsor_cron_secret das outras
--    funções. Roda de 6 em 6 horas (00:20, 06:20, 12:20 e 18:20 UTC), fora do
--    minuto 0 para não disputar worker com o job de hora em hora.
--    Quatro vezes ao dia, e não uma, porque a coleta pode voltar parcial: um
--    perfil que o Windsor não conseguiu servir entra na rodada seguinte, e o
--    upsert mescla por handle em vez de substituir a linha do dia.
--    Nome antigo: windsor-instagram-public-daily (quando era 1x/dia).
select cron.unschedule(jobname) from cron.job
where jobname in ('windsor-instagram-public-daily', 'windsor-instagram-public-6h');

select cron.schedule(
  'windsor-instagram-public-6h',
  '20 */6 * * *',
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/windsor-instagram-public',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'windsor_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $$
);

-- Secrets da Edge Function (Settings → Edge Functions → Secrets):
--   WINDSOR_API_KEY  — mesma chave da windsor-instagram (o Windsor emite uma
--                      chave por conta, não por conector)
--   CRON_SECRET      — mesmo valor guardado em vault.windsor_cron_secret
--   WINDSOR_PUBLIC_HANDLES     opcional — csv de @ para sobrescrever a lista
--                              fixa no código
--   WINDSOR_PUBLIC_DATE_PRESET opcional — default 'last_7d'

-- Disparo manual (uma coleta agora, sem esperar o cron):
--   select net.http_post(
--     url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/windsor-instagram-public',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'windsor_cron_secret')
--     ),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 60000
--   );
--   -- depois, com o request_id devolvido acima:
--   select status_code, content from net._http_response where id = <request_id>;

-- Diagnóstico:
--   select * from cron.job where jobname='windsor-instagram-public-6h';
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select metrics->>'date', jsonb_array_length(metrics->'profiles')
--     from intelligence_snapshots where period='instagram_public'
--     order by created_at desc limit 5;
