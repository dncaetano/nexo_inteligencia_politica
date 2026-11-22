-- NEXO Intelligence Engine — migrations de suporte (aplicadas no Supabase
-- project SEU_PROJECT_REF em 2026-06-29). Aditivas: não quebram
-- consumidores existentes (frontend, Strategic Assistant, Meta Collector).
-- Registradas como nexo_13..nexo_16. Este arquivo é apenas referência.

-- nexo_13: enriquece alerts (destrava gravação de alertas ricos pelos workflows)
ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS type        text,
  ADD COLUMN IF NOT EXISTS entity_id   uuid,
  ADD COLUMN IF NOT EXISTS source_url  text,
  ADD COLUMN IF NOT EXISTS metadata    jsonb,
  ADD COLUMN IF NOT EXISTS read        boolean NOT NULL DEFAULT false;
ALTER TABLE public.alerts
  ADD CONSTRAINT alerts_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES public.monitored_entities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_type ON public.alerts (type);
CREATE INDEX IF NOT EXISTS idx_alerts_campaign_created ON public.alerts (campaign_id, created_at DESC);

-- nexo_14: campos descritivos da campanha + backfill do candidato
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS candidate_name text,
  ADD COLUMN IF NOT EXISTS client_name    text,
  ADD COLUMN IF NOT EXISTS target_region  text;
UPDATE public.campaigns c
SET candidate_name = sub.name
FROM (
  SELECT DISTINCT ON (campaign_id) campaign_id, name
  FROM public.monitored_entities
  WHERE entity_type = 'candidate' AND is_active = true
  ORDER BY campaign_id, created_at ASC
) sub
WHERE sub.campaign_id = c.id AND c.candidate_name IS NULL;

-- nexo_15: base histórica para tendências (24h/7d/30d) e evolução de scores
CREATE TABLE IF NOT EXISTS public.intelligence_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  period              text NOT NULL DEFAULT '24h',
  total_mentions      integer NOT NULL DEFAULT 0,
  sentiment_positive  integer NOT NULL DEFAULT 0,
  sentiment_neutral   integer NOT NULL DEFAULT 0,
  sentiment_negative  integer NOT NULL DEFAULT 0,
  risk_score          integer NOT NULL DEFAULT 0,
  crisis_score        integer NOT NULL DEFAULT 0,
  popularity_score    integer NOT NULL DEFAULT 0,
  momentum_score      integer NOT NULL DEFAULT 0,
  media_score         integer NOT NULL DEFAULT 0,
  opportunity_score   integer NOT NULL DEFAULT 0,
  attack_score        integer NOT NULL DEFAULT 0,
  narrative_score     integer NOT NULL DEFAULT 0,
  trust_score         integer NOT NULL DEFAULT 0,
  influence_score     integer NOT NULL DEFAULT 0,
  overall_score       integer NOT NULL DEFAULT 0,
  metrics             jsonb,
  top_themes          jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intel_snapshots_campaign_created
  ON public.intelligence_snapshots (campaign_id, created_at DESC);
ALTER TABLE public.intelligence_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY intelligence_snapshots_tenant_access ON public.intelligence_snapshots
  FOR ALL TO public
  USING ( (SELECT private.is_owner()) OR (campaign_id = (SELECT private.current_campaign_id())) )
  WITH CHECK ( (SELECT private.is_owner()) OR (campaign_id = (SELECT private.current_campaign_id())) );

-- nexo_16: índice composto p/ janelas do engine
CREATE INDEX IF NOT EXISTS idx_mentions_campaign_created
  ON public.mentions (campaign_id, created_at DESC);

-- PENDENTE (tarefa separada, destrutivo): deduplicar mentions e criar índice único
-- exigido pelo upsert do News Collector:
--   CREATE UNIQUE INDEX uq_mentions_entity_url ON public.mentions (entity_id, url);
-- Hoje há duplicatas (mesma entity_id+url), então o índice ainda não foi criado.
