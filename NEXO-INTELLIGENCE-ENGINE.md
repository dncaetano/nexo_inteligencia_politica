# NEXO — Intelligence Engine (refatorado)

Motor analítico do NEXO. **Não coleta dados e não conversa com o usuário.** Lê dados
já coletados (mentions, alerts, entities), transforma em **inteligência estratégica
estruturada** e persiste relatórios + alertas + snapshots históricos para os demais
agentes consumirem (principalmente o `Strategic Assistant`).

Arquivo do workflow: [`nexo-intelligence-engine.json`](nexo-intelligence-engine.json) ·
Migrations de suporte: [`nexo-intelligence-migrations.sql`](nexo-intelligence-migrations.sql)

## Pipeline (1 responsabilidade por node)

```
Cron 1h → Init → Buscar Campanhas (is_active) → Validar → Loop por Campanha
  └─(loop)→ [Menções 24h | Menções 7d | Alertas 24h | Entidades | Snapshot Anterior]
        → Normalizar → Tem Dados?
              ├─ não → Log Sem Dados ─┐ (volta ao loop)
              └─ sim → Deduplicar → Agrupar/Clusterizar → Calcular Métricas
                     → Calcular Tendências → Strategic Metrics → Construir Contexto
                     → Construir Prompt → LLM (interpreta) → Interpretar JSON (parse+repair+fallback)
                     → Gerar Relatório e Alertas
                            ├→ Salvar Relatório → Salvar Snapshot → Preparar Alertas → Tem Alertas? → Salvar Alerta
                            └→ Log Campanha Processada ─┘ (volta ao loop)
  └─(done)→ Log Final Engine
```

Toda a **inteligência quantitativa é calculada no workflow** (determinística). O LLM
apenas **interpreta** o contexto já calculado e gera texto acionável — não recebe dados
crus nem refaz contas.

## Strategic Metrics (0–100, determinísticos)

Calculados no node **Strategic Metrics**. Benchmarks configuráveis no topo do node
(`BENCH_VOLUME=50`, `BENCH_SOURCES=10`, `BENCH_NATIONAL=5`, `BENCH_ENTITIES=5`).
Notação: `negRatio`/`posRatio` = fração negativa/positiva; `critSeverity` = média
ponderada da criticidade (low .15, medium .4, high .7, critical 1); `*Factor` = razão
clampada em [0,1] sobre o benchmark.

| Score | Fórmula | Leitura |
|---|---|---|
| **Risk** | `0.5·negRatio + 0.3·critSeverity + 0.2·avgImpact` | maior = pior |
| **Crisis** | `0.4·(critical/total) + 0.35·negRatio·avgImpact + 0.25·clamp(2·Δneg)` | pico agudo |
| **Popularity** | `0.6·posRatio + 0.2·(1−negRatio) + 0.2·volumeFactor` | maior = melhor |
| **Momentum** | `50 + 50·clamp((Δvol + Δpos − Δneg)/2)` | 50 = estável |
| **Media** | `0.4·newsVolumeFactor + 0.3·sourceDiversity + 0.3·nationalFactor` | alcance de imprensa |
| **Opportunity** | `0.5·posRatio·max(avgRel,0.3) + 0.5·(posHighImpact/total)` | aberturas favoráveis |
| **Attack** | `0.5·adversaryShare + 0.5·adversaryNegRatio` | agressão adversária |
| **Narrative** | `0.5·topThemeShare + 0.5·posRatio` | controle narrativo |
| **Trust** | `1 − (0.6·negRatio + 0.4·critSeverity)` | reputação |
| **Influence** | `0.4·volumeFactor + 0.3·sourceDiversity + 0.3·entitySpread` | alcance |
| **Overall** | `0.28·(1−risk) + 0.18·pop + 0.14·trust + 0.12·media + 0.10·opp + 0.10·mom + 0.08·(1−attack)` | posição estratégica |

Todos os scores e contadores são persistidos em `intelligence_snapshots` a cada ciclo,
formando a base histórica para `momentum`/tendências futuras (`overall_delta` compara com
o snapshot anterior).

## Detecção de tendências

Node **Calcular Tendências**: compara a janela atual (0–24h) com a anterior (24–48h,
derivada do baseline de 7 dias) e com o último snapshot. Produz: variação de volume (%),
variação de sentimento (pp), `sentiment_trend` (`growing_positive|stable|growing_negative|critical`),
temas em alta/queda e entidades crescendo/sumindo. Sem histórico, retorna `has_baseline:false`
e o sistema continua funcionando (degrada com elegância).

## Alertas determinísticos (não dependem só da IA)

Node **Gerar Relatório e Alertas**. Regras (limiares no objeto `TH`):
`risk_score≥65`, `crisis_score≥60`, `attack_score≥60`, `negRatio≥0.5`,
`negative_change_pp≥15` (com baseline). A IA **complementa** (crises/riscos/adversários/
temas que ela identificar), mas nunca é a única fonte. Alertas são deduplicados por `type+title`.

## Contrato preservado (compatibilidade)

O `Strategic Assistant` faz `JSON.parse(reports.content)`. As chaves originais são
**100% preservadas**: `summary, sentiment_analysis, themes_rising, themes_falling, risks,
opportunities, adversary_movements, narrative_changes, crisis_alerts, insights,
recommendations, agenda_suggestions, top_entities`. Foram **adicionadas** (aditivo):
`strategic_metrics, trend_analysis, data_summary, ai_parse_ok, generated_at`.

## Correções de incompatibilidade com o schema real

O engine anterior não rodava contra o banco atual. Corrigido:

- Campanhas: filtro `status='active'` → **`is_active=true`** (o status real é `'ATIVO'`).
- Colunas inexistentes (`candidate_name`, `client_name`, `target_region`) **criadas** (migration nexo_14).
- Entidades: `active` → **`is_active`** (nome real da coluna).
- Alertas: o engine gravava `type/entity_id/source_url/metadata/read` que **não existiam**
  → colunas **criadas** (nexo_13). Antes, nenhum alerta era salvo.
- `mentions.metadata` está **double-encoded** (jsonb contendo string JSON, pois o collector
  grava `JSON.stringify`). O node Normalizar trata isso (`parseMeta`: string → `JSON.parse`).
- `source_name` real é o provedor da API (`GNews`/`SerpAPI`), não o veículo. O Normalizar
  passa a derivar o **domínio da URL** (g1.globo.com, poder360.com.br) quando o nome é genérico.

## Pendências conhecidas (fora do escopo do engine)

- `mentions` tem duplicatas (mesma `entity_id+url`); o índice único `uq_mentions_entity_url`
  exigido pelo upsert do News Collector ainda não pôde ser criado. Requer deduplicação
  (operação destrutiva) — tratar no contexto do News Collector.
