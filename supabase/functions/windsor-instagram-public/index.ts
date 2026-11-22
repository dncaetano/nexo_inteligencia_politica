// Coletor dos perfis PÚBLICOS dos concorrentes via Windsor.ai.
// Acionado uma vez por dia pelo pg_cron.
//
// Não confundir com a função windsor-instagram: aquela coleta os Insights
// PRIVADOS da conta do candidato (reach, impressions, profile views), que
// só existem para o dono da conta. Esta aqui coleta o que é público de
// todo mundo — inclusive do próprio candidato, de propósito, para que a
// comparação da tabela use a mesma régua para os 11 perfis.
//
// As duas gravam em intelligence_snapshots com period diferente:
//   windsor-instagram        → period='instagram'
//   windsor-instagram-public → period='instagram_public'
// Misturar os dois period sobrescreveria os Insights do candidato.
//
// Endpoint: /all com select_accounts=instagram_public__<handle>. O conector
// não tem endpoint próprio; é o select_accounts que escolhe a fonte.
// Os handles são buscados em LOTES paralelos: numa chamada só a resposta é
// grande demais e o runtime mata a função antes de gravar (ver buscarLote).
//
// Secrets: WINDSOR_API_KEY, CRON_SECRET (mesmos da windsor-instagram).
//          WINDSOR_PUBLIC_HANDLES opcional (csv, sobrescreve HANDLES).
//          WINDSOR_PUBLIC_DATE_PRESET opcional (default last_7d).
import { createClient } from "jsr:@supabase/supabase-js@2";

const WINDSOR_ALL = "https://connectors.windsor.ai/all";

// Perfis monitorados. O @ do próprio candidato entra aqui de propósito.
//
// A ORDEM IMPORTA: a fila é servida de cima para baixo e o timeout de cada
// request é limitado pelo que resta do orçamento, então quem entra por último
// recebe os segundos finais e é abortado. Por isso os perfis PESADOS (muitos
// posts, resposta grande) vêm primeiro, com o orçamento inteiro à disposição;
// os leves ficam para o fim, onde poucos segundos bastam. Foi assim que
// pauloferraz e helenabraga, que só davam timeout, passaram a coletar.
const HANDLES = [
  // Pesados primeiro.
  "pauloferraz",
  "nelsonreis",
  "diegobraga",
  "helenabraga",
  // Depois o candidato e os adversários locais.
  "ricardolima",
  "brunoteles",
  "jorgebraga",
  "oficialotaviopires",
  "clara.teles",
  "dr_vilela",
  "andremoraes",
  "chicodopartido",
  "soniateles",
];

const FIELDS = [
  "date",
  "datasource",
  "account_name",
  "source",
  "media_type",
  "likes_per_post",
  "comments_per_post",
  "profile_media_count",
  "profile_followers_count",
];

// Quantos handles por request ao Windsor, quantos requests ao mesmo tempo, e
// quanto tempo no total antes de desistir dos lotes restantes e gravar o que
// já veio. O runtime mata a função por volta dos 150s.
// Um handle por request: medido em 2026-08-06, lotes de 2 passavam de 45s em
// perfis grandes e eram abortados. Sozinhos cabem folgados no timeout.
const LOTE_TAMANHO = 1;
// 6 e não 4: com os pesados ocupando os primeiros slots por quase dois minutos,
// sobravam poucos segundos para a fila dos leves. Duas vagas a mais deixam os
// leves correrem em paralelo aos pesados, em vez de esperarem por eles.
const CONCORRENCIA = 6;
const ORCAMENTO_MS = 125_000;
const TIMEOUT_LOTE_MS = 110_000;
// Abaixo disto não vale a pena começar um lote: não daria tempo de responder.
const TIMEOUT_MINIMO_MS = 5_000;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// O Windsor sinaliza erro de cota/plano com HTTP 200 e o texto do erro dentro
// dos campos da linha ("Uh-oh! You've connected more accounts than your Free
// plan allows..."). O filtro por datasource já barrava quase tudo aqui, mas a
// guarda explícita evita que uma mudança futura no filtro deixe passar lixo.
const MARCAS_DE_ERRO = [
  "uh-oh",
  "plan allows",
  "upgrade here",
  "onboard.windsor.ai/app/pricing",
];

function linhaDeErro(r: Record<string, unknown>): boolean {
  return Object.values(r).some((v) =>
    typeof v === "string" && MARCAS_DE_ERRO.some((m) => v.toLowerCase().includes(m))
  );
}

// Um request do Windsor para um punhado de handles. O timeout vem calculado de
// fora, limitado pelo que ainda resta do orçamento: assim um perfil lento pode
// usar bastante tempo sem nunca empurrar a função para além do limite do
// runtime, que mataria a execução antes de gravar qualquer coisa.
async function buscarLote(
  handles: string[],
  apiKey: string,
  datePreset: string,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const url = new URL(WINDSOR_ALL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("date_preset", datePreset);
  url.searchParams.set("fields", FIELDS.join(","));
  url.searchParams.set(
    "select_accounts",
    handles.map((h) => `instagram_public__${h}`).join(","),
  );
  url.searchParams.set("_renderer", "json");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url.toString(), { signal: ctrl.signal });
    const body = await resp.text();
    if (!resp.ok) {
      // Nunca deixar a chave vazar na mensagem de erro.
      throw new Error(
        `Windsor respondeu ${resp.status}: ${body.split(apiKey).join("***").slice(0, 300)}`,
      );
    }
    const json = JSON.parse(body);
    const linhas: Record<string, unknown>[] = Array.isArray(json?.data) ? json.data : [];
    const limpas = linhas.filter((r) => !linhaDeErro(r));
    if (!limpas.length && linhas.length) {
      throw new Error("Windsor devolveu erro de plano no lugar dos dados");
    }
    return limpas;
  } finally {
    clearTimeout(t);
  }
}

type Agg = {
  handle: string;
  followers: number;
  likes: number;
  comments: number;
  posts: number;
  media_count_total: number;
  first_post_date: string | null;
  last_post_date: string | null;
};

// Mesmo upsert da windsor-instagram: identifica por (campanha, period, metrics.date).
// Os perfis são MESCLADOS por handle, não substituídos: com a busca em lotes uma
// execução pode trazer só parte dos perfis, e uma coleta parcial não deve apagar
// os que já tinham vindo hoje. Perfil repetido, o mais novo ganha.
async function upsertSnapshot(
  supabase: ReturnType<typeof createClient>,
  campaignId: string,
  period: string,
  date: string,
  metrics: Record<string, unknown>,
): Promise<"inserted" | "updated"> {
  const { data: existing, error: sErr } = await supabase
    .from("intelligence_snapshots")
    .select("id, metrics")
    .eq("campaign_id", campaignId)
    .eq("period", period)
    .eq("metrics->>date", date)
    .limit(1)
    .maybeSingle();
  if (sErr) throw sErr;

  if (existing) {
    const anterior = (existing.metrics ?? {}) as Record<string, unknown>;
    const antigos = Array.isArray(anterior.profiles) ? anterior.profiles as Agg[] : [];
    const novos = Array.isArray(metrics.profiles) ? metrics.profiles as Agg[] : [];
    const porHandle = new Map<string, Agg>();
    for (const p of [...antigos, ...novos]) porHandle.set(p.handle, p);

    const final = {
      ...metrics,
      profiles: [...porHandle.values()].sort(
        (a, b) => ((b as Agg & { interactions?: number }).interactions ?? 0) -
          ((a as Agg & { interactions?: number }).interactions ?? 0),
      ),
    };
    const { error } = await supabase
      .from("intelligence_snapshots")
      .update({ metrics: final })
      .eq("id", existing.id);
    if (error) throw error;
    return "updated";
  }
  const { error } = await supabase
    .from("intelligence_snapshots")
    .insert({ campaign_id: campaignId, period, metrics });
  if (error) throw error;
  return "inserted";
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

  const apiKey = Deno.env.get("WINDSOR_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "WINDSOR_API_KEY não configurada" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const handles = (Deno.env.get("WINDSOR_PUBLIC_HANDLES") || "")
    .split(",").map((h) => h.trim()).filter(Boolean);
  const alvos = handles.length ? handles : HANDLES;
  const datePreset = Deno.env.get("WINDSOR_PUBLIC_DATE_PRESET") || "last_7d";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // 1. Buscar no Windsor, em LOTES
    // Os 10 handles numa chamada só estouravam o limite do Edge Runtime
    // (546 WORKER_LIMIT depois de 150s), e o dia inteiro se perdia. A API
    // devolve uma linha por POST, então 10 perfis × 7 dias é resposta grande
    // demais. Em lotes pequenos e paralelos cada request volta rápido, e um
    // lote que falha não leva os outros junto.
    const lotes: string[][] = [];
    for (let i = 0; i < alvos.length; i += LOTE_TAMANHO) {
      lotes.push(alvos.slice(i, i + LOTE_TAMANHO));
    }

    const inicio = Date.now();
    const rows: Record<string, unknown>[] = [];
    const falhas: { handles: string[]; erro: string }[] = [];
    const pulados: string[] = [];
    let proximo = 0;

    const worker = async () => {
      while (proximo < lotes.length) {
        // Orçamento de tempo: melhor gravar os perfis que já vieram do que
        // ser morto pelo runtime e não gravar nada.
        const restante = ORCAMENTO_MS - (Date.now() - inicio);
        if (restante < TIMEOUT_MINIMO_MS) {
          while (proximo < lotes.length) pulados.push(...lotes[proximo++]);
          return;
        }
        const lote = lotes[proximo++];
        try {
          rows.push(...await buscarLote(
            lote, apiKey, datePreset, Math.min(TIMEOUT_LOTE_MS, restante),
          ));
        } catch (e) {
          falhas.push({
            handles: lote,
            erro: String((e as Error)?.message ?? e).split(apiKey).join("***"),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCORRENCIA, lotes.length) }, worker),
    );

    if (!rows.length) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "Nenhum lote retornou linhas",
          falhas,
          pulados,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 2. Agregar por perfil
    // A API devolve UMA LINHA POR POST, repetindo os campos de perfil. Então
    // curtidas/comentários são somados e "posts" é a contagem de linhas.
    // Atenção: profile_media_count é o total histórico do perfil (a vida
    // inteira), não o do período — por isso não serve para a coluna Posts.
    const porPerfil: Record<string, Agg> = {};
    let ignoradas = 0;

    for (const r of rows) {
      // Só linhas do conector público: o select_accounts pode trazer junto a
      // conta de Insights, e misturar as duas fontes falsearia a comparação.
      if (String(r["datasource"] ?? "") !== "instagram_public") {
        ignoradas++;
        continue;
      }
      const handle = String(r["account_name"] ?? "").trim();
      if (!handle) continue;

      const a = (porPerfil[handle] ||= {
        handle,
        followers: 0,
        likes: 0,
        comments: 0,
        posts: 0,
        media_count_total: 0,
        first_post_date: null,
        last_post_date: null,
      });

      a.likes += num(r["likes_per_post"]);
      a.comments += num(r["comments_per_post"]);
      a.posts += 1;
      // Estoque: vem repetido em toda linha; o maior valor é o mais recente.
      a.followers = Math.max(a.followers, num(r["profile_followers_count"]));
      a.media_count_total = Math.max(a.media_count_total, num(r["profile_media_count"]));

      const d = String(r["date"] ?? "").slice(0, 10);
      if (d) {
        if (!a.first_post_date || d < a.first_post_date) a.first_post_date = d;
        if (!a.last_post_date || d > a.last_post_date) a.last_post_date = d;
      }
    }

    const perfis = Object.values(porPerfil)
      .map((a) => ({
        ...a,
        // Interações = curtidas + comentários. O Windsor não expõe
        // compartilhamentos, então este número fica abaixo do "Reações,
        // coment. e compart." de plataformas que têm acesso a esse dado.
        interactions: a.likes + a.comments,
      }))
      .sort((x, y) => y.interactions - x.interactions);

    // Taxa de engajamento é derivada no frontend a partir destes brutos, de
    // propósito: mudar a fórmula não deve exigir recoletar o histórico.

    if (!perfis.length) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "Nenhuma linha com datasource=instagram_public",
          linhasRecebidas: rows.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 3. Resolver campanha ativa
    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) throw new Error("Nenhuma campanha ativa encontrada");

    // 4. Gravar
    // Uma linha por DIA DE COLETA, com todos os perfis dentro. O crescimento
    // de seguidores sai de comparar coletas de dias diferentes, então a
    // coluna só passa a ter valor a partir da segunda coleta.
    const hoje = new Date().toISOString().slice(0, 10);
    const metrics = {
      source: "instagram_public",
      provider: "windsor",
      date: hoje,
      window: datePreset,
      collected_at: new Date().toISOString(),
      profiles: perfis,
    };

    const action = await upsertSnapshot(
      supabase,
      campaign.id,
      "instagram_public",
      hoje,
      metrics,
    );

    // Perfis que não vieram nesta execução: a próxima rodada do cron completa
    // a linha do dia, já que o upsert mescla por handle.
    const faltando = alvos.filter((h) => !perfis.some((p) => p.handle === h));

    return new Response(
      JSON.stringify({
        ok: true,
        date: hoje,
        action,
        perfis: perfis.length,
        de: alvos.length,
        faltando,
        lotes: { total: lotes.length, falhas, pulados },
        duracao_ms: Date.now() - inicio,
        linhasRecebidas: rows.length,
        linhasIgnoradas: ignoradas,
        resumo: perfis.map((p) => ({
          handle: p.handle,
          seguidores: p.followers,
          posts: p.posts,
          interacoes: p.interactions,
        })),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
