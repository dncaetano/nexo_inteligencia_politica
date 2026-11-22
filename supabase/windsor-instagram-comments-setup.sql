-- Coletor de COMENTÁRIOS das publicações do candidato (Windsor.ai) via
-- Edge Function + pg_cron. Aplicado no Supabase project SEU_PROJECT_REF.
-- Arquivo de referência (o mesmo SQL já foi executado).
--
-- Arquitetura:
--   pg_cron (minuto 40 de cada hora) --http--> Edge Function
--     windsor-instagram-comments
--       --> GET connectors.windsor.ai/instagram (report 'comments' + 'media_info',
--           um request por DIA, com _max_rows)
--       --> upsert em intelligence_snapshots (period='instagram_comments')
--   Aba Redes Sociais (index.html) lê via getInstagramComments() em
--   frontend/services/dashboard.service.js.
--
-- Por que de hora em hora: a coleta é ACUMULATIVA e parcial por natureza. Um dia
-- que ainda não está no cache do Windsor pode estourar o tempo de vida da função;
-- a rodada seguinte pega esse dia já em cache e soma ao snapshot, em vez de
-- substituí-lo. Em algumas rodadas a janela inteira entra.
--
-- Não confundir com os outros dois coletores de Instagram:
--   windsor-instagram         → period='instagram' / 'instagram_cities'
--   windsor-instagram-public  → period='instagram_public'
--   windsor-instagram-comments→ period='instagram_comments'  (este)

-- 1) Extensões (já criadas pelos coletores anteriores)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Agendamento. Minuto 40 para não disputar com os outros jobs
--    (0 = windsor-instagram, 10 = portal-news-monitor, 20/30 = os de 6h).
select cron.unschedule('windsor-instagram-comments-hourly')
where exists (select 1 from cron.job where jobname = 'windsor-instagram-comments-hourly');

select cron.schedule(
  'windsor-instagram-comments-hourly',
  '40 * * * *',
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/windsor-instagram-comments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'windsor_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 160000
  );
  $$
);

-- Secrets da Edge Function: os mesmos das outras funções windsor-* já bastam
--   WINDSOR_API_KEY, CRON_SECRET (= vault windsor_cron_secret)
--   WINDSOR_COMMENTS_DIAS opcional (default 7)

-- Diagnóstico:
--   -- rodar na mão, sem gravar nada:
--   select net.http_post(
--     url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/windsor-instagram-comments?dry=1&dias=2',
--     headers := jsonb_build_object('Content-Type','application/json',
--       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name='windsor_cron_secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 160000);
--   select id, status_code, content from net._http_response order by id desc limit 3;
--
--   -- o que já foi coletado:
--   select created_at, metrics->>'posts_count', metrics->>'comments_count'
--   from intelligence_snapshots where period='instagram_comments'
--   order by created_at desc limit 5;
