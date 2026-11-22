// Substitui o workflow n8n "NEXO - News Collector", que parou em 19/08/2026
// sem deixar erro em lugar nenhum: o cron do n8n simplesmente não disparava
// mais, e ninguém percebeu por onze dias. Aqui a execução fica no log do
// Supabase e o cron é o pg_cron, igual aos coletores do Instagram.
//
// Faz o mesmo caminho do workflow antigo:
//   entidades ativas → busca no Google News → dedup por URL →
//   texto da matéria → análise com IA → mentions + alerts
//
// DUAS FONTES, e a escolha é de orçamento, não técnica:
//   'rss'     — feed público do Google News. Sem chave, sem cota, sem custo.
//               É o padrão, e cobre todas as entidades a cada rodada.
//   'serpapi' — a mesma busca, pela API paga. Foi ela que derrubou o coletor
//               antigo: o plano tem 1.000 buscas por MÊS e o n8n varria 28
//               entidades a cada 30 minutos — 1.344 por dia. Nessa fonte a
//               rodada busca só o candidato + 1 adversário do rodízio, e a
//               trava MIN_HORAS_ENTRE_BUSCAS_PAGAS impede o cron de repetir
//               o estouro.
// Os 17 portais ficam fora das duas: a portal-news-monitor já lê o RSS deles.
//
// Secrets (Settings → Edge Functions → Secrets):
//   OPENROUTER_API_KEY  — chave do OpenRouter para a análise. Obrigatória.
//   NEWS_FONTE          — 'rss' (padrão) ou 'serpapi'.
//   SERPAPI_KEY         — só quando NEWS_FONTE='serpapi'. Use uma chave NOVA:
//                         a antiga estava hardcoded no nexo-news-collector.json
//                         e foi exposta no repositório.
//   CRON_SECRET         — o mesmo dos outros coletores (vault windsor_cron_secret).
//   NEWS_ADVERSARIOS_RODADA / NEWS_MAX_ARTIGOS — opcionais, ajustam a fatia.
//
// ?dry=1 busca sem gravar (e sem exigir a chave de IA, para dar para conferir
// a fonte antes de configurar tudo); ?fonte=rss|serpapi e ?adversarios=N
// mudam o comportamento só naquela chamada.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SERPAPI = "https://serpapi.com/search.json";
// Feed público do Google News — mesmo acervo da SerpAPI, sem chave e sem cota.
// Não é uma API contratada: não tem SLA nem suporte, e o Google pode mudar o
// formato sem avisar. É a fonte certa enquanto a cota paga está esgotada.
const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
// Mesmo modelo e temperatura do nó "OpenRouter Chat Model" do workflow antigo.
const MODELO = "openai/gpt-4o-mini";

// Fonte de busca: 'rss' (Google News, grátis) ou 'serpapi' (paga, com cota).
// Trocar pelo secret NEWS_FONTE, sem mexer no código.
const FONTE_PADRAO = "rss";

// ORÇAMENTO DE BUSCAS — a razão de tudo aqui ser pequeno.
// O plano da SerpAPI tem 1.000 buscas por MÊS, e foi estourá-lo que derrubou o
// coletor antigo em 19/08. Fazendo as contas: 1.000 ÷ 30 dias ≈ 33 buscas/dia.
//
// Cada rodada gasta (1 candidato + ADVERSARIOS_POR_RODADA) buscas. Com o cron
// de 3 em 3 horas, são 8 rodadas/dia × 2 buscas = 16/dia ≈ 480/mês — menos da
// metade da cota, deixando folga para testes manuais e para o mês em que a
// campanha esquentar.
//
// Mexer nesses números sem refazer a conta é a forma mais fácil de repetir o
// apagão de agosto.
const ADVERSARIOS_POR_RODADA = 1;
const MAX_ARTIGOS_RODADA = 12;
const RESULTADOS_POR_BUSCA = 10;

// Trava de segurança da fonte paga: mesmo que o cron rode de hora em hora (o
// que faz sentido com o RSS grátis), na SerpAPI uma entidade só é buscada de
// novo depois deste intervalo. Sem isso, trocar NEWS_FONTE para 'serpapi' e
// esquecer de afrouxar o cron repetiria o estouro de cota de agosto.
const MIN_HORAS_ENTRE_BUSCAS_PAGAS = 3;

// Portais NÃO entram na busca paga: os 17 já são varridos de hora em hora pela
// portal-news-monitor, que lê o RSS de cada um de graça. O workflow do n8n
// gastava uma busca "site:jornaldaserra.com" em cada portal — 17 das 28 buscas de
// cada rodada iam para conteúdo que já tínhamos.
const TIPOS_BUSCAVEIS = ["candidate", "opponent", "party", "influencer"];

// Marcas da resposta de cota esgotada da SerpAPI. Sem reconhecê-las, o coletor
// falha em silêncio — exatamente o que aconteceu em agosto.
const MARCAS_SEM_COTA = [
  "run out of searches",
  "exceeded your searches",
  "searches per month",
  "account has run out",
  "plan searches limit",
];

const ORCAMENTO_MS = 120_000;
const TIMEOUT_BUSCA_MS = 20_000;
const TIMEOUT_ARTIGO_MS = 8_000;
const TIMEOUT_IA_MS = 25_000;
const CONCORRENCIA_BUSCA = 3;
const CONCORRENCIA_ANALISE = 4;

const MAX_CONTEUDO_IA = 4000;

type Entidade = {
  id: string;
  campaign_id: string;
  name: string;
  entity_type: string;
};

type Artigo = {
  title: string;
  url: string;
  source_name: string;
  published_at: string;
  snippet: string;
  author: string;
  full_content?: string;
};

type Analise = {
  sentiment: "positive" | "neutral" | "negative";
  relevance_score: number;
  impact_score: number;
  summary: string;
  principais_temas: string[];
  citacao_direta: boolean;
  mencao_adversario: boolean;
  criticidade: "low" | "medium" | "high" | "critical";
  justificativa: string;
};

const ANALISE_PADRAO: Analise = {
  sentiment: "neutral",
  relevance_score: 0.5,
  impact_score: 0.5,
  summary: "",
  principais_temas: [],
  citacao_direta: false,
  mencao_adversario: false,
  criticidade: "low",
  justificativa: "",
};

// Lê um secret aceitando MAIÚSCULAS ou minúsculas. Deno.env é sensível a
// caixa, e o painel do Supabase aceita qualquer grafia: um secret salvo como
// "openrouter_api_key" simplesmente não existia para quem procurava
// "OPENROUTER_API_KEY", e a função reclamava de chave faltando com a chave
// cadastrada bem ali na tela.
function env(nome: string): string | undefined {
  return Deno.env.get(nome) ?? Deno.env.get(nome.toLowerCase()) ??
    Deno.env.get(nome.toUpperCase());
}

function txt(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function num(v: unknown, padrao: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

// Nenhuma mensagem de erro pode carregar a chave: elas voltam no JSON da
// resposta, que é lido pelo cron e fica gravado em net._http_response.
function semSegredo(e: unknown, ...segredos: string[]): string {
  let s = String((e as Error)?.message ?? e);
  for (const seg of segredos) if (seg) s = s.split(seg).join("***");
  return s.slice(0, 300);
}

async function comTimeout(url: string, ms: number, init?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Roda tarefas com concorrência limitada, respeitando o orçamento de tempo.
async function emParalelo<T>(
  tarefas: (() => Promise<T>)[],
  concorrencia: number,
  inicio: number,
): Promise<T[]> {
  const saida: T[] = [];
  let proximo = 0;
  const worker = async () => {
    while (proximo < tarefas.length) {
      if (Date.now() - inicio > ORCAMENTO_MS) return;
      const t = tarefas[proximo++];
      saida.push(await t());
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concorrencia, tarefas.length) }, worker),
  );
  return saida;
}

// 1. Query de busca — mesma lógica do nó "Construir Query de Pesquisa"
function montarQuery(e: Entidade): string {
  const nome = e.name || "";
  switch (e.entity_type) {
    case "candidate": return `"${nome}" candidato político notícias`;
    case "opponent": return `"${nome}" adversário político`;
    case "party": return `"${nome}" partido político`;
    case "influencer": return `"${nome}" influenciador`;
    case "portal": return `site:${nome}`;
    default: return `"${nome}" notícias`;
  }
}

// 2. Datas do SerpAPI
// A API mistura formatos: relativo ("há 2 horas", "2 hours ago"), brasileiro
// ("16/07/2026") e por extenso ("16 de julho de 2026"). Sem converter, tudo
// vira "agora" e a linha do tempo da aba Notícias fica achatada.
const MESES: Record<string, number> = {
  jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5,
  jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11,
};

function parseData(bruto: string): string {
  const s = txt(bruto).toLowerCase();
  if (!s) return new Date().toISOString();

  // Relativo, em português ou inglês.
  const rel = s.match(/(\d+)\s*(minuto|min|hora|hour|dia|day|semana|week|m[eê]s|month)/);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2];
    const agora = new Date();
    if (/min/.test(u)) agora.setMinutes(agora.getMinutes() - n);
    else if (/hora|hour/.test(u)) agora.setHours(agora.getHours() - n);
    else if (/dia|day/.test(u)) agora.setDate(agora.getDate() - n);
    else if (/semana|week/.test(u)) agora.setDate(agora.getDate() - n * 7);
    else agora.setMonth(agora.getMonth() - n);
    return agora.toISOString();
  }

  // 16/07/2026
  const br = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) {
    const d = new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]), 12);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // 16 de julho de 2026
  const ext = s.match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/);
  if (ext) {
    const mes = MESES[ext[2].slice(0, 3)];
    if (mes != null) {
      const d = new Date(Number(ext[3]), mes, Number(ext[1]), 12);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }

  const direto = new Date(bruto);
  return isNaN(direto.getTime()) ? new Date().toISOString() : direto.toISOString();
}

// 3. Busca na SerpAPI
async function buscarNoticias(apiKey: string, query: string): Promise<Artigo[]> {
  const url = new URL(SERPAPI);
  url.searchParams.set("q", query);
  url.searchParams.set("tbm", "nws");
  url.searchParams.set("num", String(RESULTADOS_POR_BUSCA));
  url.searchParams.set("hl", "pt-BR");
  url.searchParams.set("gl", "br");
  url.searchParams.set("tbs", "qdr:d"); // últimas 24 horas
  url.searchParams.set("api_key", apiKey);

  const resp = await comTimeout(url.toString(), TIMEOUT_BUSCA_MS);
  const body = await resp.text();
  const semCota = MARCAS_SEM_COTA.some((m) => body.toLowerCase().includes(m));
  if (semCota) {
    const e = new Error("SerpAPI: cota mensal de buscas esgotada");
    (e as Error & { semCota?: boolean }).semCota = true;
    throw e;
  }
  if (!resp.ok) {
    throw new Error(`SerpAPI ${resp.status}: ${body.split(apiKey).join("***").slice(0, 200)}`);
  }
  const json = JSON.parse(body);
  if (json?.error) throw new Error(`SerpAPI: ${String(json.error).slice(0, 200)}`);

  const linhas = Array.isArray(json?.news_results) ? json.news_results : [];
  return linhas.map((a: Record<string, unknown>) => ({
    title: txt(a.title),
    url: txt(a.link),
    source_name: txt((a.source as Record<string, unknown>)?.name ?? a.source),
    published_at: parseData(txt(a.date)),
    snippet: txt(a.snippet),
    author: txt(a.author),
  })).filter((a: Artigo) => a.title && a.url);
}

// 3b. Busca no Google News RSS (grátis)
// Mesmo parser de <item> que a portal-news-monitor usa nos feeds dos portais.
function decodeEntidades(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function semTags(s: string): string {
  return decodeEntidades(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagXml(bloco: string, nome: string): string {
  const m = bloco.match(new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`, "i"));
  return m ? decodeEntidades(m[1]).trim() : "";
}

async function buscarNoticiasRss(query: string): Promise<Artigo[]> {
  const url = new URL(GOOGLE_NEWS_RSS);
  // when:1d é o equivalente ao tbs=qdr:d da SerpAPI: só as últimas 24 horas.
  url.searchParams.set("q", `${query} when:1d`);
  url.searchParams.set("hl", "pt-BR");
  url.searchParams.set("gl", "BR");
  url.searchParams.set("ceid", "BR:pt-419");

  const resp = await comTimeout(url.toString(), TIMEOUT_BUSCA_MS, {
    headers: { "User-Agent": "NexoInteligenciaPolitica/1.0 (monitoramento de imprensa)" },
  });
  if (!resp.ok) throw new Error(`Google News RSS ${resp.status}`);
  const xml = await resp.text();

  const blocos = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocos.slice(0, RESULTADOS_POR_BUSCA).map((b) => {
    // O título do Google News vem "Manchete - Veículo"; a fonte também está em
    // <source>, que é mais confiável para separar as duas coisas.
    const tituloBruto = semTags(tagXml(b, "title"));
    const fonte = semTags(tagXml(b, "source"));
    const titulo = fonte && tituloBruto.endsWith(` - ${fonte}`)
      ? tituloBruto.slice(0, -(fonte.length + 3))
      : tituloBruto;
    const data = tagXml(b, "pubDate");
    return {
      title: titulo,
      // O link é o redirecionador do Google. Fica assim de propósito: resolver
      // para a URL final exigiria seguir o redirect de cada item, e o que
      // importa aqui é ter uma URL estável para deduplicar e para o usuário
      // abrir. O buscarConteudo() segue o redirect quando vai ler o texto.
      url: tagXml(b, "link").trim(),
      source_name: fonte,
      published_at: parseData(data),
      snippet: semTags(tagXml(b, "description")).slice(0, 500),
      author: "",
    };
  }).filter((a) => a.title && a.url);
}

// 4. Texto da matéria
// Falha aqui não descarta o artigo: sem o corpo, a análise usa o snippet — é
// o que o workflow antigo fazia, e é melhor que perder a notícia.
async function buscarConteudo(url: string): Promise<string> {
  try {
    const resp = await comTimeout(url, TIMEOUT_ARTIGO_MS, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NexoBot/1.0)" },
    });
    if (!resp.ok) return "";
    const html = await resp.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CONTEUDO_IA);
  } catch {
    return "";
  }
}

// 5. Análise — mesmo prompt e mesmo formato de resposta do workflow antigo
async function analisar(
  apiKey: string,
  entidade: Entidade,
  artigo: Artigo,
): Promise<Analise> {
  const prompt = `Analise esta notícia sobre ${entidade.name} (${entidade.entity_type}):

TÍTULO: ${artigo.title}
FONTE: ${artigo.source_name}
CONTEÚDO: ${artigo.full_content || artigo.snippet}

IMPORTANTE: o campo sentiment deve refletir o sentimento da notícia EM RELAÇÃO a ${entidade.name}, não o tom geral da matéria.

Retorne JSON com esta estrutura exata:
{
  "sentiment": "positive" | "neutral" | "negative",
  "relevance_score": 0.0-1.0,
  "impact_score": 0.0-1.0,
  "summary": "resumo em 2-3 frases",
  "principais_temas": ["tema1", "tema2"],
  "citacao_direta": true/false,
  "mencao_adversario": true/false,
  "criticidade": "low" | "medium" | "high" | "critical",
  "justificativa": "breve justificativa da análise"
}`;

  const resp = await comTimeout(OPENROUTER, TIMEOUT_IA_MS, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO,
      temperature: 0.1,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Você é um analista político especializado em monitoramento de mídia brasileira. Analise notícias e retorne APENAS JSON válido, sem markdown, sem texto antes ou depois.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenRouter ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = JSON.parse(body);
  const bruto = txt(json?.choices?.[0]?.message?.content);
  const limpo = bruto.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  const parsed = JSON.parse(limpo) as Partial<Analise>;
  return {
    ...ANALISE_PADRAO,
    ...parsed,
    // O modelo às vezes devolve os scores como string; normalizamos aqui para
    // as regras de alerta poderem comparar com número sem susto.
    relevance_score: num(parsed.relevance_score, 0.5),
    impact_score: num(parsed.impact_score, 0.5),
    principais_temas: Array.isArray(parsed.principais_temas) ? parsed.principais_temas : [],
  };
}

// 6. Alertas — as mesmas 5 regras do nó "Verificar Condições de Alerta"
function montarAlertas(
  entidade: Entidade,
  artigo: Artigo,
  a: Analise,
): Record<string, unknown>[] {
  const alertas: Record<string, unknown>[] = [];
  const base = {
    campaign_id: entidade.campaign_id,
    entity_id: entidade.id,
    source_url: artigo.url,
    read: false,
  };

  if (a.sentiment === "negative" && a.impact_score >= 0.7) {
    alertas.push({
      ...base,
      type: "negative_sentiment",
      title: `Cobertura Negativa: ${entidade.name}`,
      description: `Notícia com sentimento negativo de alto impacto detectada: "${artigo.title}"`,
      severity: a.impact_score >= 0.9 ? "critical" : "high",
      metadata: {
        relevance_score: a.relevance_score,
        impact_score: a.impact_score,
        source: artigo.source_name,
      },
    });
  }

  if (a.relevance_score >= 0.85) {
    alertas.push({
      ...base,
      type: "high_relevance",
      title: `Alta Relevância: ${entidade.name}`,
      description: `Matéria de alta relevância detectada: "${artigo.title}"`,
      severity: "high",
      metadata: { relevance_score: a.relevance_score, temas: a.principais_temas },
    });
  }

  if (a.citacao_direta && entidade.entity_type === "candidate") {
    alertas.push({
      ...base,
      type: "direct_quote",
      title: `Citação Direta: ${entidade.name}`,
      description: `${entidade.name} foi citado diretamente em: "${artigo.title}"`,
      severity: a.sentiment === "negative" ? "high" : "medium",
      metadata: { sentiment: a.sentiment, source: artigo.source_name },
    });
  }

  if (a.citacao_direta && entidade.entity_type === "opponent") {
    alertas.push({
      ...base,
      type: "opponent_mention",
      title: `Adversário Citado: ${entidade.name}`,
      description: `Adversário ${entidade.name} foi citado diretamente em: "${artigo.title}"`,
      severity: "medium",
      metadata: { sentiment: a.sentiment, impact_score: a.impact_score },
    });
  }

  // Criticidade crítica só vira alerta próprio se a regra 1 já não cobriu.
  if (a.criticidade === "critical" && !alertas.some((x) => x.type === "negative_sentiment")) {
    alertas.push({
      ...base,
      type: "critical_coverage",
      title: `Cobertura Crítica: ${entidade.name}`,
      description: `IA classificou como CRÍTICO: "${artigo.title}" - ${a.justificativa}`,
      severity: "critical",
      metadata: { justificativa: a.justificativa, temas: a.principais_temas },
    });
  }

  return alertas;
}

Deno.serve(async (req: Request) => {
  const expected = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const qs = new URL(req.url).searchParams;
  const dry = qs.get("dry") === "1";
  const fonte = (qs.get("fonte") || env("NEWS_FONTE") || FONTE_PADRAO).toLowerCase();
  const usaSerp = fonte === "serpapi";

  const serpKey = env("SERPAPI_KEY");
  const iaKey = env("OPENROUTER_API_KEY");
  const faltando = [
    // O RSS não pede chave: só cobramos a da SerpAPI quando ela é a fonte.
    usaSerp && !serpKey ? "SERPAPI_KEY" : null,
    // Em dry-run a análise é opcional: dá para conferir a busca antes de ter
    // a chave de IA configurada.
    !iaKey && !dry ? "OPENROUTER_API_KEY" : null,
  ].filter(Boolean);
  if (faltando.length) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "secrets_faltando",
        message: `Configure em Settings → Edge Functions → Secrets: ${faltando.join(", ")}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // No RSS, que é grátis, a rodada cobre todos os adversários; na fonte paga,
  // só o rodízio configurado. O teto de artigos continua valendo nos dois
  // casos — é ele que segura o custo da análise de IA.
  const adversariosPorRodada = Math.max(0, Math.min(10, Number(
    qs.get("adversarios") || env("NEWS_ADVERSARIOS_RODADA") ||
      (usaSerp ? ADVERSARIOS_POR_RODADA : 10),
  )));
  const tetoArtigos = Math.max(1, Math.min(40, Number(
    env("NEWS_MAX_ARTIGOS") || MAX_ARTIGOS_RODADA,
  )));

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const inicio = Date.now();

  try {
    // 1. Fatia da fila
    // O candidato entra em TODA rodada (é o que a campanha precisa saber
    // primeiro); os adversários entram por rodízio, do há mais tempo sem
    // checagem. Portais ficam de fora — ver TIPOS_BUSCAVEIS.
    // Na fonte paga, quem foi buscado há pouco fica de fora da rodada — é a
    // trava que mantém o gasto previsível mesmo com cron frequente.
    const limiteRebusca = new Date(
      Date.now() - MIN_HORAS_ENTRE_BUSCAS_PAGAS * 3600 * 1000,
    ).toISOString();
    const filtroTrava = `news_last_checked_at.is.null,news_last_checked_at.lt.${limiteRebusca}`;

    let qCand = supabase
      .from("monitored_entities")
      .select("id, campaign_id, name, entity_type")
      .eq("is_active", true)
      .eq("entity_type", "candidate");
    if (usaSerp) qCand = qCand.or(filtroTrava);
    const { data: candidatos, error: cErr } = await qCand;
    if (cErr) throw cErr;

    let qOutros = supabase
      .from("monitored_entities")
      .select("id, campaign_id, name, entity_type")
      .eq("is_active", true)
      .in("entity_type", TIPOS_BUSCAVEIS.filter((t) => t !== "candidate"));
    if (usaSerp) qOutros = qOutros.or(filtroTrava);
    const { data: outros, error: oErr } = await qOutros
      .order("news_last_checked_at", { ascending: true, nullsFirst: true })
      .limit(adversariosPorRodada);
    if (oErr) throw oErr;

    const entidades = [...(candidatos || []), ...(outros || [])] as Entidade[];
    if (!entidades.length) {
      return new Response(
        JSON.stringify({ ok: true, message: "Nenhuma entidade buscável ativa", entidades: 0 }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 2. Buscar notícias de cada uma
    const achados: { entidade: Entidade; artigo: Artigo }[] = [];
    const falhas: { entidade: string; etapa: string; erro: string }[] = [];
    let semCota = false;

    await emParalelo(
      entidades.map((ent) => async () => {
        if (semCota) return; // não queima as buscas restantes à toa
        try {
          const artigos = usaSerp
            ? await buscarNoticias(serpKey!, montarQuery(ent))
            : await buscarNoticiasRss(montarQuery(ent));
          for (const artigo of artigos) achados.push({ entidade: ent, artigo });
        } catch (e) {
          if ((e as Error & { semCota?: boolean }).semCota) semCota = true;
          falhas.push({ entidade: ent.name, etapa: "busca", erro: semSegredo(e, serpKey || "") });
        }
      }),
      CONCORRENCIA_BUSCA,
      inicio,
    );

    // Cota estourada é o que derrubou o coletor antigo por onze dias sem que
    // ninguém visse. Aqui vira alerta na Central de Alertas — no máximo um por
    // dia, para não virar spam enquanto a cota não é renovada.
    if (semCota && !dry) {
      const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: jaAvisado } = await supabase
        .from("alerts")
        .select("id")
        .eq("type", "collector_down")
        .gte("created_at", desde)
        .limit(1);
      if (!jaAvisado?.length) {
        await supabase.from("alerts").insert({
          campaign_id: entidades[0].campaign_id,
          type: "collector_down",
          title: "Coleta de notícias parada: cota da SerpAPI esgotada",
          description:
            "A SerpAPI recusou as buscas por falta de cota mensal. A aba Notícias segue " +
            "recebendo apenas os portais de Serra Grande (RSS), sem o Google News. Renove o " +
            "plano ou aguarde a virada do mês para a coleta voltar sozinha.",
          severity: "high",
          read: false,
          metadata: { collector: "news-collector", provider: "serpapi" },
        });
      }
    }

    // 3. Deduplicar: dentro da rodada e contra o que já está no banco
    const vistos = new Set<string>();
    const unicos = achados.filter(({ artigo }) => {
      if (!artigo.url || vistos.has(artigo.url)) return false;
      vistos.add(artigo.url);
      return true;
    });

    let jaGravados = new Set<string>();
    if (unicos.length) {
      const { data: existentes, error: mErr } = await supabase
        .from("mentions")
        .select("url")
        .in("url", unicos.map((u) => u.artigo.url));
      if (mErr) throw mErr;
      jaGravados = new Set((existentes || []).map((m: { url: string }) => m.url));
    }

    const novos = unicos.filter(({ artigo }) => !jaGravados.has(artigo.url))
      .slice(0, tetoArtigos);

    // 4. Conteúdo + análise
    const analisados: { entidade: Entidade; artigo: Artigo; analise: Analise }[] = [];

    await emParalelo(
      novos.map(({ entidade, artigo }) => async () => {
        try {
          artigo.full_content = await buscarConteudo(artigo.url);
          const analise = iaKey
            ? await analisar(iaKey, entidade, artigo)
            : ANALISE_PADRAO;
          analisados.push({ entidade, artigo, analise });
        } catch (e) {
          falhas.push({ entidade: entidade.name, etapa: "analise", erro: semSegredo(e, iaKey || "") });
        }
      }),
      CONCORRENCIA_ANALISE,
      inicio,
    );

    if (dry) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry: true,
          fonte,
          duracao_ms: Date.now() - inicio,
          entidades: entidades.map((e) => e.name),
          encontrados: achados.length,
          novos: novos.length,
          analisados: analisados.length,
          falhas,
          amostra: analisados.slice(0, 3).map(({ entidade, artigo, analise }) => ({
            entidade: entidade.name,
            titulo: artigo.title,
            fonte: artigo.source_name,
            sentimento: analise.sentiment,
            relevancia: analise.relevance_score,
            criticidade: analise.criticidade,
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 5. Gravar mentions
    const agora = new Date().toISOString();
    const linhas = analisados.map(({ entidade, artigo, analise }) => ({
      campaign_id: entidade.campaign_id,
      entity_id: entidade.id,
      source: "news",
      title: artigo.title.slice(0, 500),
      content: artigo.full_content || artigo.snippet,
      sentiment: analise.sentiment,
      url: artigo.url,
      published_at: artigo.published_at,
      created_at: agora,
      metadata: {
        source_name: artigo.source_name,
        author: artigo.author,
        relevance_score: analise.relevance_score,
        impact_score: analise.impact_score,
        summary: analise.summary,
        principais_temas: analise.principais_temas,
        citacao_direta: analise.citacao_direta,
        mencao_adversario: analise.mencao_adversario,
        criticidade: analise.criticidade,
        justificativa: analise.justificativa,
        api_source: usaSerp ? "serpapi" : "google_news_rss",
        entity_type: entidade.entity_type,
        entity_name: entidade.name,
        collector: "news-collector",
      },
    }));

    if (linhas.length) {
      const { error } = await supabase.from("mentions").insert(linhas);
      if (error) throw error;
    }

    // 6. Alertas
    const alertas = analisados.flatMap(({ entidade, artigo, analise }) =>
      montarAlertas(entidade, artigo, analise)
    );
    if (alertas.length) {
      const { error } = await supabase.from("alerts").insert(alertas);
      if (error) throw error;
    }

    // 7. Marcar a fila
    // Só as entidades que chegaram a ser buscadas; as puladas pelo orçamento
    // continuam na frente da fila para a próxima rodada.
    const buscadas = entidades
      .filter((e) => !falhas.some((f) => f.entidade === e.name && f.etapa === "busca"))
      .map((e) => e.id);
    if (buscadas.length) {
      const { error } = await supabase
        .from("monitored_entities")
        .update({ news_last_checked_at: agora })
        .in("id", buscadas);
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        fonte,
        duracao_ms: Date.now() - inicio,
        entidades: entidades.map((e) => e.name),
        encontrados: achados.length,
        novos: novos.length,
        mentions_gravadas: linhas.length,
        alertas_gerados: alertas.length,
        falhas,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: semSegredo(e, serpKey || "", iaKey || ""),
        duracao_ms: Date.now() - inicio,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
