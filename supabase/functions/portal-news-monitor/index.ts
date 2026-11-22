// Coletor dedicado aos portais de imprensa serranos (entity_type='portal'
// em monitored_entities). Lê os feeds RSS dos veículos, filtra as matérias
// que tratam do candidato ou da direita serrana e grava em public.mentions.
//
// Por que RSS e não busca:
//   Para uma lista fixa de veículos, o feed é superior à busca por palavra —
//   é gratuito (sem cota de SerpAPI/NewsAPI), traz a matéria com data real de
//   publicação e não depende de a busca ter indexado a página. O news collector
//   do n8n continua fazendo o trabalho de descoberta ampla (candidato e
//   adversários em qualquer fonte); este agente cuida só dos portais.
//
// Fluxo:
//   1. Autentica a chamada do cron pelo header x-cron-secret (== env PORTAL_CRON_SECRET).
//   2. Pega os N portais da fila (os há mais tempo sem checagem).
//   3. Descobre o feed do portal (caminhos padrão + <link rel=alternate>) e
//      memoriza em portal_feeds para não redescobrir a cada execução.
//   4. Lê o feed, filtra por pautas monitoradas, deduplica por URL.
//   5. Insere em public.mentions com source='portal_rss'. Só monitoramento —
//      sem análise de sentimento/IA; sentiment fica null de propósito.
//
// Secrets (Settings → Edge Functions → Secrets):
//   PORTAL_CRON_SECRET  — nome diferente de propósito: secrets de Edge
//     Function são globais no projeto, e a função windsor-instagram já usa
//     CRON_SECRET — reaproveitar o nome sobrescreveria o valor dela.
//     Mesmo valor guardado no Vault (portal_monitor_cron_secret).
//   PORTAL_MONITOR_BATCH — opcional; portais por execução (default 20, cobre
//     os 17 cadastrados numa passada só — sem custo de IA, rodar 1x/hora
//     sobre todos é mais barato que dividir em lotes menores e mais frequentes)
import { createClient } from "jsr:@supabase/supabase-js@2";

const ITEM_MAX_AGE_DAYS = 7; // ignora matérias mais antigas que isso
const MAX_ITEMS_PER_FEED = 60;

// Caminhos tentados na descoberta do feed, em ordem. Cobrem WordPress
// (/feed), portais custom (/rss, /rss.xml) e o padrão do Na Mira da Notícia.
const FEED_PATHS = [
  "/feed",
  "/rss",
  "/feed/",
  "/rss.xml",
  "/feed.xml",
  "/index.xml",
  "/atom.xml",
  "/rss/noticias",
];

// Pautas monitoradas. Mesma lógica de três níveis usada no filtro do
// Instagram: termo do candidato casa sozinho; termo de campo político casa
// sozinho quando já é específico; termo amplo exige contexto serrano.
const CANDIDATE_TERMS = [
  "ricardo lima",
  "ricardo lima teixeira",
];
const FIELD_TERMS = [
  "direita serrana",
  "direita de serra grande",
  "campo conservador",
  "ferrazismo em serra grande",
  "oposicao serrana",
];
// Só termos inequivocamente políticos. "direita" e "oposicao" ficaram de fora
// de propósito: em feed de portal generalista elas aparecem o tempo todo fora
// de contexto ("cruzou pela direita", "faixa da direita"), e um teste com os
// feeds reais mostrou matéria de futebol do o time local entrando por causa disso.
// Quando são de fato políticas, vêm qualificadas e caem em FIELD_TERMS.
const BROAD_TERMS = [
  "direitista",
  "direitistas",
  "conservador",
  "conservadora",
  "conservadores",
  "conservadoras",
  "bolsonarista",
  "bolsonaristas",
  "ferrazismo",
];
const LOCAL_TERMS = [
  "serra grande",
  "serrano",
  "serrana",
  "serranos",
  "serranas",
  "portoverde",
  "al",
];

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Casamento por limite de palavra: "al" não pode casar dentro de "serra grande",
// nem "direita" dentro de "direitas".
function hasTerm(haystack: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(haystack);
}

type MatchResult = { matched: boolean; terms: string[]; tier: string };

function matchText(text: string): MatchResult {
  const t = norm(text);
  if (!t) return { matched: false, terms: [], tier: "" };
  const hits: string[] = [];

  for (const term of CANDIDATE_TERMS) if (hasTerm(t, term)) hits.push(term);
  if (hits.length) return { matched: true, terms: hits, tier: "candidate" };

  for (const term of FIELD_TERMS) if (hasTerm(t, term)) hits.push(term);
  if (hits.length) return { matched: true, terms: hits, tier: "field" };

  if (LOCAL_TERMS.some((l) => hasTerm(t, l))) {
    for (const term of BROAD_TERMS) if (hasTerm(t, term)) hits.push(term);
    if (hits.length) return { matched: true, terms: hits, tier: "broad_local" };
  }
  return { matched: false, terms: [], tier: "" };
}

// Parsing de RSS
// Os feeds destes portais são RSS 2.0 simples; extrair por regex evita puxar
// um parser XML inteiro para o edge runtime. CDATA e entidades são tratados.
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

type FeedItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
};

function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ||
    xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const items: FeedItem[] = [];
  for (const b of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    // Atom usa <link href="...">; RSS usa <link>...</link>. O feed do
    // 5minutos não traz <link> nenhum — só <guid> com a URL, e prefixado
    // ("https:https://..."), então ele entra como último recurso e é saneado.
    let link = tag(b, "link");
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    if (!link) {
      const g = tag(b, "guid");
      if (/^https?:/i.test(g)) link = g;
    }
    link = link.trim().replace(/^https?:(?=https?:\/\/)/i, "");
    // Alguns feeds mandam a matéria em content:encoded; o description do SG24
    // vem literalmente como "None".
    const descRaw = tag(b, "content:encoded") || tag(b, "description") ||
      tag(b, "summary");
    const desc = descRaw.trim().toLowerCase() === "none" ? "" : stripTags(descRaw);
    items.push({
      title: stripTags(tag(b, "title")),
      link: link.trim(),
      description: desc,
      pubDate: tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"),
    });
  }
  return items;
}

async function fetchText(url: string, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "NexoInteligenciaPolitica/1.0 (monitoramento de imprensa)" },
    });
  } finally {
    clearTimeout(to);
  }
}

// Descobre o feed: tenta os caminhos conhecidos e, se nenhum servir, procura
// a declaração <link rel="alternate" type="application/rss+xml"> na home.
async function discoverFeed(domain: string): Promise<string | null> {
  const base = `https://${domain}`;
  for (const path of FEED_PATHS) {
    try {
      const r = await fetchText(base + path, 10000);
      const ct = r.headers.get("content-type") || "";
      if (r.ok && /xml/i.test(ct)) return base + path;
    } catch (_e) { /* tenta o próximo */ }
  }
  try {
    const r = await fetchText(base, 12000);
    if (r.ok) {
      const html = await r.text();
      const m = html.match(
        /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i,
      );
      const href = m?.[0].match(/href=["']([^"']+)["']/i)?.[1];
      if (href) return href.startsWith("http") ? href : base + href;
    }
  } catch (_e) { /* sem feed */ }
  return null;
}

Deno.serve(async (req: Request) => {
  const expected = Deno.env.get("PORTAL_CRON_SECRET");
  if (!expected || req.headers.get("x-cron-secret") !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const batchSize = Number(Deno.env.get("PORTAL_MONITOR_BATCH")) || 20;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) throw new Error("Nenhuma campanha ativa encontrada");

    // Fila: portais cadastrados + estado do feed. Ordena pelos que estão há
    // mais tempo sem checagem (nulos primeiro = nunca checados).
    const { data: portals, error: pErr } = await supabase
      .from("monitored_entities")
      .select("id, name, portal_feeds(feed_url, feed_status, last_checked_at)")
      .eq("campaign_id", campaign.id)
      .eq("entity_type", "portal")
      .eq("is_active", true);
    if (pErr) throw pErr;

    const queue = (portals || [])
      .map((p) => {
        const st = Array.isArray(p.portal_feeds) ? p.portal_feeds[0] : p.portal_feeds;
        return { id: p.id, domain: p.name, state: st ?? null };
      })
      .sort((a, b) => {
        const ta = a.state?.last_checked_at ? Date.parse(a.state.last_checked_at) : 0;
        const tb = b.state?.last_checked_at ? Date.parse(b.state.last_checked_at) : 0;
        return ta - tb;
      })
      .slice(0, batchSize);

    if (!queue.length) {
      return new Response(
        JSON.stringify({ ok: true, message: "Nenhum portal ativo na fila" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const cutoff = Date.now() - ITEM_MAX_AGE_DAYS * 24 * 3600 * 1000;
    const report: Record<string, unknown>[] = [];

    for (const p of queue) {
      const checkedAt = new Date().toISOString();
      let scanned = 0, matched = 0, inserted = 0;
      let feedUrl = p.state?.feed_url || null;
      let status = "ok";
      let errMsg: string | null = null;

      try {
        if (!feedUrl) {
          feedUrl = await discoverFeed(p.domain);
          if (!feedUrl) {
            // Sem feed: o portal segue coberto pela busca ampla do n8n.
            status = "none";
            throw new Error("nenhum feed RSS encontrado");
          }
        }

        const resp = await fetchText(feedUrl, 20000);
        if (!resp.ok) throw new Error(`feed respondeu ${resp.status}`);
        const items = parseFeed(await resp.text());

        for (const it of items) {
          if (!it.link) continue;
          const ts = it.pubDate ? Date.parse(it.pubDate) : NaN;
          if (!isNaN(ts) && ts < cutoff) continue;
          scanned++;

          const hit = matchText(`${it.title} ${it.description}`);
          if (!hit.matched) continue;
          matched++;

          // Item isolado num try próprio: uma falha pontual (rede, um campo
          // ruim) não deve derrubar o resto do feed — cada matéria é
          // independente. O erro do último item, se houver, entra no report.
          try {
            // Dedupe por URL — mentions não tem unique constraint; o controle
            // é aqui, mesmo critério do news collector.
            const { data: dup } = await supabase
              .from("mentions")
              .select("id")
              .eq("campaign_id", campaign.id)
              .eq("url", it.link)
              .limit(1)
              .maybeSingle();
            if (dup) continue;

            const { error: insErr } = await supabase.from("mentions").insert({
              campaign_id: campaign.id,
              // mentions.entity_id é NOT NULL; como o portal cobre o veículo
              // (não uma pessoa específica), usa o próprio registro do portal
              // em monitored_entities como entidade — já existe (entity_type='portal').
              entity_id: p.id,
              source: "portal_rss",
              title: it.title.slice(0, 300),
              content: it.description,
              url: it.link,
              published_at: !isNaN(ts) ? new Date(ts).toISOString() : checkedAt,
              metadata: {
                api_source: "portal_rss",
                source_name: p.domain,
                feed_url: feedUrl,
                matched_terms: hit.terms,
                match_tier: hit.tier,
                collected_at: checkedAt,
              },
            });
            if (insErr) throw insErr;
            inserted++;
          } catch (itemErr) {
            errMsg = String((itemErr as Error)?.message ?? itemErr).slice(0, 300);
          }
        }
        report.push({ portal: p.domain, feed: feedUrl, scanned, matched, inserted, itemError: errMsg });
      } catch (e) {
        errMsg = String((e as Error)?.message ?? e).slice(0, 300);
        if (status === "ok") status = "error";
        report.push({ portal: p.domain, status, error: errMsg });
      }

      // Estado do portal: memoriza o feed descoberto e o resultado da rodada.
      await supabase.from("portal_feeds").upsert({
        entity_id: p.id,
        feed_url: feedUrl,
        feed_status: status,
        last_checked_at: checkedAt,
        last_error: errMsg,
      }, { onConflict: "entity_id" });
    }

    return new Response(
      JSON.stringify({ ok: true, portais: report.length, report }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("portal-news-monitor erro:", e);
    return new Response(
      JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
