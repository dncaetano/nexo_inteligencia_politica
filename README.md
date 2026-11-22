# NEXO — Inteligência Política

Central de monitoramento e análise para uma campanha política: notícias sobre o
candidato e os adversários, insights do Instagram, alertas e relatórios.

Página estática (HTML + JS puro, sem bundler e sem build step) sobre o
`dc-runtime`, com Supabase como backend e um conjunto de coletores agendados
que alimentam o banco.

Os nomes de pessoas, partidos, cidades e veículos de imprensa neste
repositório são fictícios, e as fotos são avatares gerados. O sistema roda em
produção com outros dados.

## Arquitetura

```
index.html                 Aplicação inteira: markup dc + script do componente
runtime/support.js         dc-runtime (renderização e binding)
frontend/services/*.js     Acesso ao Supabase (plain JS, window.NexoServices)
backend/component.js       Cópia de referência do script do index.html
supabase/functions/        Edge Functions (Deno) — os coletores
supabase/*.sql             Agendamento pg_cron de cada coletor
nexo-*.json                Workflows n8n (motor analítico e assistente)
nexo-intelligence-migrations.sql   Migrações aplicadas no schema
```

O `index.html` é a fonte de produção. `backend/component.js` existe para leitura
do código fora do HTML e pode divergir dele.

### Coletores

Cada um roda como Edge Function, disparada pelo `pg_cron`, e grava em
`intelligence_snapshots` ou `mentions`:

| Função | Frequência | O que coleta |
|---|---|---|
| `windsor-instagram` | 1h | Insights da conta própria (alcance, impressões, seguidores) |
| `windsor-instagram-public` | 6h | Perfis públicos dos concorrentes |
| `windsor-instagram-comments` | 1h | Comentários das publicações do candidato |
| `news-collector` | 1h | Notícias via RSS do Google News + análise com IA |
| `portal-news-monitor` | 1h | RSS dos portais de imprensa serranos |
| `ranking-politico-scraper` | 6h | Ranking digital de políticos de Serra Grande |

O agendamento e os segredos de cada um estão no `.sql` correspondente em
`supabase/`. Os valores ficam no Vault do Supabase e nos secrets da Edge
Function — nada disso está versionado.

## Rodando local

```bash
cp frontend/services/config.example.js frontend/services/config.js
# preencher URL e publishable key do seu projeto Supabase
python -m http.server 4173
```

Abrir pelo `file://` não funciona: os scripts usam caminho relativo e o
Supabase exige origem HTTP.

## Deploy

Vercel, sem build step: Framework Preset `Other`, build e install vazios,
output `.`. O `vercel.json` define `cleanUrls` e os cabeçalhos de cache.

Em produção, `frontend/services/config.js` precisa existir no deploy — ele está
no `.gitignore` por conter a chave do projeto.

## Chaves

Nenhuma chave está neste repositório. A *publishable key* do Supabase (pública
por design, protegida por RLS) fica no `config.js` local. As chaves de
servidor — `service_role`, Windsor.ai, SerpAPI, OpenAI — são lidas de variáveis
de ambiente nas Edge Functions e do Vault no agendamento.
