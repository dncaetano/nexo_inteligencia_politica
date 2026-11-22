// Coleta dados públicos do ranking digital de políticos de Serra Grande
// e persiste em intelligence_snapshots (period='ranking_politico').
//
// Acionado a cada 6 horas pelo pg_cron.
// Secrets: CRON_SECRET (autenticação do cron).
import { createClient } from "jsr:@supabase/supabase-js@2";

const RANKING_URL = "https://rankingpoliticos.yellowkite.digital/?cargo=geral";

// Helpers

function parseMetricValue(raw: string): number {
  const clean = (raw ?? "").replace(/[+\s]/g, "");
  if (clean.includes("%")) return parseFloat(clean.replace(",", ".")) || 0;
  if (/K$/i.test(clean)) return Math.round(parseFloat(clean.replace(",", ".")) * 1000);
  if (/M$/i.test(clean)) return Math.round(parseFloat(clean.replace(",", ".")) * 1_000_000);
  // Número puro: pontos/vírgulas são separadores de milhar ("33.502" → 33502).
  return parseInt(clean.replace(/[.,]/g, ""), 10) || 0;
}

interface RankEntry {
  rank: number;
  nome: string;
  partido: string;
  cargo: string;
  cidade?: string;
  valor: string;
  valorNum: number;
}

interface TopPost {
  rank: number;
  tipo: string;
  nome: string;
  partido: string;
  texto: string;
  curtidas: number;
  comentarios: number;
  total: number;
  link?: string;
  thumb?: string;
}

// Extrai, do HTML cru, o permalink do Instagram e a capa (cover do vídeo) de
// cada Top Post, na ordem do documento — que é a ordem do rank. Delimita à
// seção "Top Posts" → "Menos interações" para não pegar posts de outras abas.
function extractTopPostMedia(html: string): { link: string; thumb: string }[] {
  const decoded = html.replace(/&amp;/g, "&");
  const tp = decoded.indexOf("Top Posts");
  if (tp === -1) return [];
  const mi = decoded.indexOf("Menos intera");
  const region = decoded.slice(tp, mi === -1 ? tp + 200_000 : mi);

  const linkRe = /https:\/\/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/g;
  const seen = new Set<string>();
  const out: { link: string; thumb: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(region)) !== null) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);
    // A capa fica logo após o href de abertura do card.
    const win = region.slice(m.index, m.index + 2500);
    const img = win.match(
      /https:\/\/[^"'\\ )]*cdninstagram[^"'\\ )]*\.jpg[^"'\\ )]*/,
    );
    out.push({
      link: `https://instagram.com/p/${code}`,
      thumb: img ? img[0] : "",
    });
  }
  return out;
}

// Parsing

function parseTextBasedRanking(pageText: string): {
  interacoes: RankEntry[];
  seguidores: RankEntry[];
  engajamento: RankEntry[];
  top_posts: TopPost[];
  mais_postagens: RankEntry[];
  menos_interacoes: RankEntry[];
  menos_seguidores: RankEntry[];
} {
  const lines = pageText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const sectionStarts: Record<string, number> = {};
  const sectionNames = [
    "Interações",
    "Seguidores",
    "Engajamento",
    "Mais postagens",
    "Top Posts",
    "Menos interações",
    "Menos seguidores",
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const name of sectionNames) {
      if (lines[i] === name && !sectionStarts[name]) {
        sectionStarts[name] = i;
      }
    }
  }

  function extractSection(
    startName: string,
    endName: string | null,
  ): string[] {
    const start = sectionStarts[startName];
    if (start === undefined) return [];
    const end = endName && sectionStarts[endName] !== undefined
      ? sectionStarts[endName]
      : start + 200;
    return lines.slice(start, Math.min(end, lines.length));
  }

  // Estrutura real de cada entrada (texto extraído por linha):
  //   "01" (rank) · "JH" (iniciais do avatar) · "Bruno Teles" (nome) ·
  //   "PDR / Pré-candidato(a) a Governador" (partido / cargo) ·
  //   "Roteiro" (cidade, opcional) · "74K+" (valor) · "interações" (rótulo).
  // O nome pode conter "/" ("Paulinho/Paulo José..."), então a âncora é a
  // linha partido/cargo, que sempre tem " / " (com espaços). O nome é a
  // linha imediatamente anterior a essa âncora — o que descarta as iniciais.
  function parseEntries(sectionLines: string[]): RankEntry[] {
    const entries: RankEntry[] = [];
    const rankRe = /^0[1-9]$|^10$/;
    let i = 0;

    while (i < sectionLines.length && entries.length < 10) {
      if (!rankRe.test(sectionLines[i])) {
        i++;
        continue;
      }
      const rank = parseInt(sectionLines[i], 10);
      i++;

      // Âncora: primeira linha "PARTIDO / CARGO" (com " / ") antes do próximo rank.
      let slash = -1;
      for (let j = i; j < sectionLines.length && j < i + 5; j++) {
        if (rankRe.test(sectionLines[j])) break;
        if (sectionLines[j].includes(" / ")) {
          slash = j;
          break;
        }
      }
      if (slash === -1 || slash === 0) continue;

      const nome = sectionLines[slash - 1];
      const parts = sectionLines[slash].split("/");
      const partido = parts[0].trim();
      const cargo = parts.slice(1).join("/").trim();

      let k = slash + 1;
      let cidade = "";
      if (
        k < sectionLines.length &&
        !rankRe.test(sectionLines[k]) &&
        !/\d/.test(sectionLines[k]) &&
        !sectionLines[k].includes("%") &&
        sectionLines[k].length < 40 &&
        !/interaç|seguidor|taxa|postag|novo|total|curtida|coment/i.test(
          sectionLines[k],
        )
      ) {
        cidade = sectionLines[k];
        k++;
      }

      let valor = "";
      while (k < sectionLines.length && !rankRe.test(sectionLines[k]) && !valor) {
        if (/\d/.test(sectionLines[k]) || sectionLines[k].includes("%")) {
          valor = sectionLines[k];
        }
        k++;
      }

      if (nome) {
        entries.push({
          rank,
          nome,
          partido,
          cargo,
          cidade: cidade || undefined,
          valor: valor || "0",
          valorNum: parseMetricValue(valor || "0"),
        });
      }
      i = k;
    }
    return entries;
  }

  // Estrutura real de cada top post:
  //   "#" · "1" (rank em linhas separadas) · "Vídeo" (tipo) · "JH" (iniciais) ·
  //   "Bruno Teles" (nome) · "PDR / ..." (partido/cargo) · texto (1+ linhas) ·
  //   "29K+"/"3K+"/"33K+" (curtidas/comentários/total). Âncora no " / ".
  function parseTopPosts(sectionLines: string[]): TopPost[] {
    const posts: TopPost[] = [];
    let i = 0;
    while (i < sectionLines.length && posts.length < 20) {
      if (
        sectionLines[i] === "#" &&
        i + 1 < sectionLines.length &&
        /^\d+$/.test(sectionLines[i + 1])
      ) {
        const rank = parseInt(sectionLines[i + 1], 10);
        i += 2;
        const tipo = sectionLines[i] ?? "";
        i++;

        let slash = -1;
        for (let j = i; j < sectionLines.length && j < i + 5; j++) {
          if (sectionLines[j] === "#") break;
          if (sectionLines[j].includes(" / ")) {
            slash = j;
            break;
          }
        }
        if (slash === -1 || slash === 0) {
          i++;
          continue;
        }

        const nome = sectionLines[slash - 1];
        const partido = sectionLines[slash].split("/")[0].trim();

        let k = slash + 1;
        let texto = "";
        const numbers: number[] = [];
        while (k < sectionLines.length && numbers.length < 3 && sectionLines[k] !== "#") {
          const ln = sectionLines[k];
          if (/\d/.test(ln) && (/K\+/.test(ln) || /^\d[\d.,]*$/.test(ln))) {
            numbers.push(parseMetricValue(ln));
          } else if (!texto) {
            texto = ln;
          }
          k++;
        }

        if (nome && numbers.length >= 3) {
          posts.push({
            rank,
            tipo,
            nome,
            partido,
            texto,
            curtidas: numbers[0],
            comentarios: numbers[1],
            total: numbers[2],
          });
        }
        i = k;
      } else {
        i++;
      }
    }
    // A página repete cada post duas vezes (versão abreviada "29K+" e versão
    // exata "29.936"). Deduplica por rank, preferindo a de maior total (exata).
    const byRank = new Map<number, TopPost>();
    for (const p of posts) {
      const cur = byRank.get(p.rank);
      if (!cur || p.total > cur.total) byRank.set(p.rank, p);
    }
    return [...byRank.values()].sort((a, b) => a.rank - b.rank);
  }

  return {
    interacoes: parseEntries(extractSection("Interações", "Seguidores")),
    seguidores: parseEntries(extractSection("Seguidores", "Engajamento")),
    engajamento: parseEntries(extractSection("Engajamento", "Mais postagens")),
    mais_postagens: parseEntries(
      extractSection("Mais postagens", "Top Posts"),
    ),
    top_posts: parseTopPosts(
      extractSection("Top Posts", "Menos interações"),
    ),
    menos_interacoes: parseEntries(
      extractSection("Menos interações", "Menos seguidores"),
    ),
    menos_seguidores: parseEntries(
      extractSection("Menos seguidores", null),
    ),
  };
}

// Main handler

Deno.serve(async (req: Request) => {
  const expected = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const resp = await fetch(RANKING_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });
    if (!resp.ok) {
      throw new Error(`Página retornou ${resp.status}`);
    }

    const html = await resp.text();

    // Converte cada fronteira de tag em quebra de linha: isso produz um token
    // por linha (rank, nome, partido/cargo, valor…), que é o formato esperado
    // por parseTextBasedRanking. Mais robusto que textContent de um DOM parser,
    // que colapsaria elementos inline numa única linha.
    const pageText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/[ \t]+/g, " ");

    const ranking = parseTextBasedRanking(pageText);

    // Anexa permalink + capa (extraídos do HTML cru) a cada top post, por ordem.
    const media = extractTopPostMedia(html);
    ranking.top_posts = ranking.top_posts.map((p, i) => ({
      ...p,
      link: media[i]?.link ?? "",
      thumb: media[i]?.thumb ?? "",
    }));

    const total =
      ranking.interacoes.length +
      ranking.seguidores.length +
      ranking.engajamento.length +
      ranking.top_posts.length;

    if (total === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          message: "Nenhum dado extraído — possível mudança no layout",
          total: 0,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Buscar campanha ativa
    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) throw new Error("Nenhuma campanha ativa encontrada");

    const today = new Date().toISOString().slice(0, 10);
    const metrics = {
      date: today,
      collected_at: new Date().toISOString(),
      interacoes: ranking.interacoes,
      seguidores: ranking.seguidores,
      engajamento: ranking.engajamento,
      mais_postagens: ranking.mais_postagens,
      menos_interacoes: ranking.menos_interacoes,
      menos_seguidores: ranking.menos_seguidores,
      top_posts: ranking.top_posts,
    };

    // Upsert: uma linha por dia
    const { data: existing } = await supabase
      .from("intelligence_snapshots")
      .select("id")
      .eq("campaign_id", campaign.id)
      .eq("period", "ranking_politico")
      .eq("metrics->>date", today)
      .limit(1)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("intelligence_snapshots")
        .update({ metrics })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("intelligence_snapshots")
        .insert({
          campaign_id: campaign.id,
          period: "ranking_politico",
          metrics,
        });
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        action: existing ? "updated" : "inserted",
        date: today,
        counts: {
          interacoes: ranking.interacoes.length,
          seguidores: ranking.seguidores.length,
          engajamento: ranking.engajamento.length,
          mais_postagens: ranking.mais_postagens.length,
          menos_interacoes: ranking.menos_interacoes.length,
          menos_seguidores: ranking.menos_seguidores.length,
          top_posts: ranking.top_posts.length,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("ranking-politico-scraper error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
