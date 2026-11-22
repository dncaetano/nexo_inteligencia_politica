-- Coletor de NOTÍCIAS (SerpAPI + OpenRouter) via Edge Function + pg_cron.
-- Aplicado no Supabase project SEU_PROJECT_REF. Arquivo de referência
-- (o mesmo SQL já foi executado).
--
-- Substitui o workflow n8n "NEXO - News Collector", que parou em 19/08/2026 e
-- ficou onze dias sem coletar nada. A causa era a COTA: o plano da SerpAPI tem
-- 1.000 buscas por mês e o workflow varria 28 entidades a cada 30 minutos —
-- 1.344 buscas por dia. Estourada a cota, ele parou sem erro visível em lugar
-- nenhum. Ver nexo-news-collector.json, mantido no repo só como referência do
-- desenho antigo.
--
-- Arquitetura:
--   pg_cron (de hora em hora) --http--> Edge Function news-collector
--     --> monitored_entities: candidato + adversários (portais ficam de fora)
--     --> Google News: feed RSS (grátis) ou SerpAPI (paga) — ver NEWS_FONTE
--     --> dedup por URL contra a própria tabela mentions
--     --> texto da matéria + análise com gpt-4o-mini (OpenRouter)
--     --> insert em mentions (source='news') e em alerts (5 regras)
--   Aba Notícias e Central de Alertas leem direto dessas tabelas.
--
-- FONTE ATUAL: 'rss' (feed público do Google News). Sem chave, sem cota, sem
-- custo — por isso o cron é de hora em hora e a rodada cobre todas as
-- entidades. Em 08/09/2026, quando a cota da SerpAPI renovar, basta trocar o
-- secret NEWS_FONTE para 'serpapi': a função sozinha volta a buscar só o
-- candidato + 1 adversário por rodada e respeita MIN_HORAS_ENTRE_BUSCAS_PAGAS,
-- sem precisar mexer neste cron.
--
-- O RITMO DA FONTE PAGA SAI DA COTA, não do gosto: 1.000 buscas/mês dão ~33
-- por dia, e o n8n gastava 1.344.
--
-- Os 17 PORTAIS ficaram de fora das buscas pagas: a portal-news-monitor já lê
-- o RSS de todos eles de hora em hora, de graça. Eram 17 das 28 buscas de cada
-- rodada do n8n gastas para trazer o que já tínhamos.

-- 1) Coluna de fila (migração add_news_last_checked_at_to_monitored_entities)
-- alter table public.monitored_entities add column if not exists news_last_checked_at timestamptz;

-- 2) Agendamento. Minuto 5 para não cair junto com os outros jobs
--    (0 = windsor-instagram, 10 = portal-news-monitor, 40 = comentários).
select cron.unschedule('news-collector-hourly')
where exists (select 1 from cron.job where jobname = 'news-collector-hourly');

select cron.schedule(
  'news-collector-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/news-collector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'windsor_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- Secrets da Edge Function (Settings → Edge Functions → Secrets):
--   OPENROUTER_API_KEY  — chave do OpenRouter (modelo openai/gpt-4o-mini).
--                         Obrigatória: sem ela não há sentimento nem alertas.
--   NEWS_FONTE          — 'rss' (padrão, grátis) ou 'serpapi'.
--   SERPAPI_KEY         — só na fonte paga. Chave NOVA: a antiga estava
--                         hardcoded no nexo-news-collector.json, versionado no
--                         GitHub, e precisa ser revogada.
--   CRON_SECRET         — já existe, compartilhado com os coletores windsor-*.
--   NEWS_ADVERSARIOS_RODADA / NEWS_MAX_ARTIGOS — opcionais. CUIDADO: cada
--                         adversário a mais por rodada custa 8 buscas/dia
--                         (240/mês) da cota de 1.000.

-- Diagnóstico:
--   -- rodar na mão sem gravar nada:
--   select net.http_post(
--     url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/news-collector?dry=1&entidades=2',
--     headers := jsonb_build_object('Content-Type','application/json',
--       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name='windsor_cron_secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 150000);
--   select id, status_code, content from net._http_response order by id desc limit 3;
--
--   -- a fila, na ordem em que será servida:
--   select name, entity_type, news_last_checked_at from monitored_entities
--   where is_active order by news_last_checked_at nulls first;
--
--   -- o que entrou hoje:
--   select count(*), max(created_at) from mentions
--   where source='news' and created_at > now() - interval '24 hours';
