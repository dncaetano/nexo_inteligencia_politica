// Coletor de Insights de conta do Instagram via API REST do Windsor.ai.
// Acionado de hora em hora pelo pg_cron.
//
// Faz TRÊS chamadas ao Windsor (a API aceita só um breakdown por request):
//   1. /instagram  → série diária da conta (reach, impressions, engajadas...)
//                    grava period='instagram' (uma linha por dia)
//   2. /instagram  → estoque atual (seguidores, seguindo, posts), uma linha
//                    só; misturar com a série corrompe o número de seguidores
//   3. /all        → audiência por cidade (breakdown 'city')
//                    grava period='instagram_cities' (uma linha por coleta)
//
// Secrets: WINDSOR_API_KEY, CRON_SECRET (= vault windsor_cron_secret).
//          WINDSOR_DATE_PRESET opcional (default last_7d).
import { createClient } from "jsr:@supabase/supabase-js@2";

const WINDSOR_INSTAGRAM = "https://connectors.windsor.ai/instagram";
const WINDSOR_ALL = "https://connectors.windsor.ai/all";

// Série diária. NÃO inclui os campos de estoque de propósito — ver STOCK_FIELDS.
const WINDSOR_FIELDS = [
  "date",
  "user_name",
  "account_id",
  "profile_views",
  "reach",
  "impressions",
  "accounts_engaged",
  "follower_count_1d",
];

// Estoque (seguidores/seguindo/posts). Precisa ser um request PRÓPRIO.
// Estes campos não têm série histórica: a API devolve UMA linha, com o valor
// de agora. Quando pedidos junto com as métricas diárias, o Windsor espalha o
// número pelas linhas de data e cada linha recebe um pedaço — era daí que saía
// o 794.223 travado, enquanto o valor real da conta era 856.384.
const WINDSOR_STOCK_FIELDS = ["date", "user_name", "account_id", "followers_count", "follows_count", "media_count"];
// Audiência por cidade: o NOME vem em 'city' (audience_city_name vem vazio) e a
// QUANTIDADE de seguidores em 'audience_city_size'. Precisa ser request próprio
// porque a API só aceita um breakdown por chamada.
const CITY_FIELDS = ["date", "datasource", "account_name", "city", "audience_city_size"];

const STOCK_FIELDS = ["followers_count", "follows_count", "media_count"];
const FLOW_FIELDS = ["reach", "impressions", "profile_views", "accounts_engaged"];

// Seguidores GANHOS no dia — a única série temporal real de seguidores que a
// API oferece (followers_count é só o total de agora). É o que permite montar
// um gráfico de crescimento honesto. Fica fora de FLOW_FIELDS de propósito:
// não deve influenciar hasFlow, que decide se o dia já tem dados para gravar.
const GAIN_FIELD = "follower_count_1d";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// O Windsor sinaliza erro de cota/plano com HTTP 200 e o texto do erro dentro
// dos próprios campos da linha, em vez de um status de erro. Estes são os
// pedaços que identificam essa resposta; novos casos: acrescentar aqui.
const MARCAS_DE_ERRO = [
  "uh-oh",
  "plan allows",
  "upgrade here",
  "onboard.windsor.ai/app/pricing",
];

function pareceErro(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.toLowerCase();
  return MARCAS_DE_ERRO.some((m) => s.includes(m));
}

function respostaDeErro(rows: Record<string, unknown>[]): boolean {
  return rows.some((r) => Object.values(r).some(pareceErro));
}

function mensagemDeErro(rows: Record<string, unknown>[]): string {
  for (const r of rows) {
    for (const v of Object.values(r)) {
      if (pareceErro(v)) return String(v).slice(0, 300);
    }
  }
  return "";
}

// A API do Windsor devolve alguns nomes de cidade com perda de acentuação: cada
// byte do caractere acentuado vira '?' (em UTF-8 "Í" tem 2 bytes, então virou
// "??"). A perda é irreversível, então corrigimos os fragmentos conhecidos.
// Novos casos: adicionar o par aqui.
const CITY_NAME_FIXES: [RegExp, string][] = [
  [/\?\?ndios/g, "Índios"],   // Palmeira dos ??ndios → Palmeira dos Índios
];
function fixCityName(name: string): string {
  let out = name;
  for (const [re, to] of CITY_NAME_FIXES) out = out.replace(re, to);
  return out;
}

// Upsert de uma linha de snapshot identificada por (campaign, period, metrics.date).
// `preservar` lista chaves que, se já existirem na linha gravada, não devem ser
// sobrescritas. Serve para o histórico de seguidores: como a API só sabe dizer
// quantos seguidores existem AGORA, reescrever os dias passados com o número de
// hoje achataria o histórico numa linha reta. Cada dia guarda o valor que era
// verdade quando foi coletado pela primeira vez.
async function upsertSnapshot(
  supabase: ReturnType<typeof createClient>,
  campaignId: string,
  period: string,
  date: string,
  metrics: Record<string, unknown>,
  preservar: string[] = [],
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
    const final = { ...metrics };
    for (const k of preservar) {
      if (Number(anterior[k]) > 0) final[k] = anterior[k];
    }
    // Se o valor preservado veio da reconstrução, a marca vai junto.
    if (preservar.includes("followers_count") && anterior.followers_estimated) {
      final.followers_estimated = anterior.followers_estimated;
    }
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
  // 1. Autenticação do cron
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

  const datePreset = Deno.env.get("WINDSOR_DATE_PRESET") || "last_7d";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // 2. Série diária da conta
    const url = new URL(WINDSOR_INSTAGRAM);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("date_preset", datePreset);
    url.searchParams.set("fields", WINDSOR_FIELDS.join(","));
    url.searchParams.set("_renderer", "json");

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Windsor respondeu ${resp.status}: ${body.slice(0, 500)}`);
    }
    const json = await resp.json();
    const rows: Record<string, unknown>[] = Array.isArray(json?.data) ? json.data : [];

    if (!rows.length) {
      return new Response(
        JSON.stringify({ ok: true, message: "Windsor não retornou linhas", rows: 0 }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 2b. A resposta é de verdade?
    // Quando a conta estoura o limite do plano, o Windsor responde HTTP 200
    // com a mensagem de erro DENTRO dos campos ("Uh-oh! You've connected more
    // accounts than your Free plan allows...") e as métricas zeradas. Sem esta
    // guarda o coletor gravava o dia com tudo em 0 e o nome da conta virava a
    // mensagem — foi o que apagou o dashboard em 17/08/2026.
    if (respostaDeErro(rows)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "windsor_plan_limit",
          message: mensagemDeErro(rows) ||
            "Windsor devolveu erro de plano no lugar dos dados",
          gravado: false,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    // 3. Agregar por dia
    const byDate: Record<string, Record<string, number>> = {};
    const meta: Record<string, { user_name?: string; account_id?: string }> = {};
    for (const r of rows) {
      const date = String(r["date"] ?? "").slice(0, 10);
      if (!date) continue;
      const acc = (byDate[date] ||= {});
      for (const f of FLOW_FIELDS) acc[f] = (acc[f] || 0) + num(r[f]);
      acc[GAIN_FIELD] = (acc[GAIN_FIELD] || 0) + num(r[GAIN_FIELD]);
      meta[date] = {
        user_name: r["user_name"] != null ? String(r["user_name"]) : meta[date]?.user_name,
        account_id: r["account_id"] != null ? String(r["account_id"]) : meta[date]?.account_id,
      };
    }
    const dates = Object.keys(byDate).sort();
    const hasFlow = (d: string) => FLOW_FIELDS.some((f) => (byDate[d][f] || 0) > 0);

    let ident = [...dates].reverse()
      .map((d) => meta[d]).find((m) => m && (m.user_name || m.account_id)) || {};

    // 3b. Estoque, em request separado
    // Uma linha só, com o número de seguidores DESTE instante. Ver o comentário
    // em WINDSOR_STOCK_FIELDS para o motivo de não vir junto com a série.
    const sUrl = new URL(WINDSOR_INSTAGRAM);
    sUrl.searchParams.set("api_key", apiKey);
    sUrl.searchParams.set("date_preset", datePreset);
    sUrl.searchParams.set("fields", WINDSOR_STOCK_FIELDS.join(","));
    sUrl.searchParams.set("_renderer", "json");

    const sResp = await fetch(sUrl.toString());
    if (!sResp.ok) {
      const body = await sResp.text();
      throw new Error(`Windsor (estoque) respondeu ${sResp.status}: ${body.slice(0, 500)}`);
    }
    const sJson = await sResp.json();
    const sRowsBrutas: Record<string, unknown>[] = Array.isArray(sJson?.data) ? sJson.data : [];
    // Mesma guarda da série: erro de plano vem como texto dentro dos campos.
    const sRows = respostaDeErro(sRowsBrutas) ? [] : sRowsBrutas;

    const stock: Record<string, number> = {};
    for (const f of STOCK_FIELDS) {
      stock[f] = Math.max(0, ...sRows.map((r) => num(r[f])));
    }
    // A linha de estoque é a mais fresca que existe: se ela traz identificação,
    // ela ganha da série diária.
    const sIdent = sRows.find((r) => r["user_name"] != null || r["account_id"] != null);
    if (sIdent) {
      ident = {
        user_name: sIdent["user_name"] != null ? String(sIdent["user_name"]) : ident.user_name,
        account_id: sIdent["account_id"] != null ? String(sIdent["account_id"]) : ident.account_id,
      };
    }

    // 4. Resolver campanha ativa
    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) throw new Error("Nenhuma campanha ativa encontrada");

    // 5. Gravar dias COM métricas de fluxo (o dia corrente entra no dia seguinte)
    // Sem fluxo em nenhum dia, o último dia só é gravado se ao menos o estoque
    // veio: uma linha com TUDO zerado vira um card "0 ▼100%" no dashboard, e é
    // exatamente o que aparece logo depois da virada do dia, quando o dia novo
    // ainda não tem métrica nenhuma.
    const flowDays = dates.filter(hasFlow);
    const temEstoque = STOCK_FIELDS.some((f) => (stock[f] || 0) > 0);
    const daysToSave = flowDays.length
      ? flowDays
      : (temEstoque ? dates.slice(-1) : []);

    if (!daysToSave.length) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "Windsor não devolveu métrica nenhuma (nem fluxo, nem estoque)",
          gravado: false,
          days_returned: dates,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // O estoque de agora só vale para o dia mais recente. Nos dias anteriores
    // preservamos o número que já tinha sido gravado, senão toda coleta
    // reescreveria a série inteira com o valor de hoje.
    const diaMaisRecente = daysToSave[daysToSave.length - 1];

    const collectedAt = new Date().toISOString();
    const saved: { date: string; action: string; followers: number }[] = [];
    for (const d of daysToSave) {
      const agg = byDate[d];
      const metrics = {
        source: "instagram",
        provider: "windsor",
        date: d,
        user_name: ident.user_name ?? null,
        account_id: ident.account_id ?? null,
        followers_count: stock["followers_count"] || 0,
        follows_count: stock["follows_count"] || 0,
        media_count: stock["media_count"] || 0,
        reach: agg["reach"] || 0,
        impressions: agg["impressions"] || 0,
        profile_views: agg["profile_views"] || 0,
        accounts_engaged: agg["accounts_engaged"] || 0,
        followers_gained: agg[GAIN_FIELD] || 0,
        collected_at: collectedAt,
      };
      const action = await upsertSnapshot(
        supabase, campaign.id, "instagram", d, metrics,
        d === diaMaisRecente ? [] : STOCK_FIELDS,
      );
      saved.push({ date: d, action, followers: metrics.followers_count });
    }

    // 6. Audiência por cidade (breakdown próprio)
    // Falha aqui não derruba a coleta diária: reportamos no retorno.
    let cities: { name: string; followers: number }[] = [];
    let citiesResult: Record<string, unknown> = { ok: false };
    try {
      const cUrl = new URL(WINDSOR_ALL);
      cUrl.searchParams.set("api_key", apiKey);
      cUrl.searchParams.set("date_preset", datePreset);
      cUrl.searchParams.set("fields", CITY_FIELDS.join(","));
      cUrl.searchParams.set("_renderer", "json");

      const cResp = await fetch(cUrl.toString());
      const cText = await cResp.text();
      if (!cResp.ok) throw new Error(`HTTP ${cResp.status}: ${cText.slice(0, 300)}`);
      const cJson = JSON.parse(cText);
      const cRows: Record<string, unknown>[] = Array.isArray(cJson?.data) ? cJson.data : [];

      const byCity = new Map<string, number>();
      let cityDate = "";
      for (const r of cRows) {
        const ds = r["datasource"];
        if (ds != null && String(ds) !== "instagram") continue;
        const name = r["city"];
        const size = num(r["audience_city_size"]);
        if (!name || size <= 0) continue;
        const key = fixCityName(String(name));
        byCity.set(key, Math.max(byCity.get(key) || 0, size));
        const d = String(r["date"] ?? "").slice(0, 10);
        if (d > cityDate) cityDate = d;
      }

      if (byCity.size) {
        // ranking: do maior para o menor
        cities = [...byCity.entries()]
          .map(([name, followers]) => ({ name, followers }))
          .sort((a, b) => b.followers - a.followers);

        const date = cityDate || collectedAt.slice(0, 10);
        const cityMetrics = {
          source: "instagram",
          provider: "windsor",
          type: "audience_cities",
          date,
          user_name: ident.user_name ?? null,
          total_cities: cities.length,
          followers_mapped: cities.reduce((s, c) => s + c.followers, 0),
          cities,
          collected_at: collectedAt,
        };
        const action = await upsertSnapshot(
          supabase, campaign.id, "instagram_cities", date, cityMetrics,
        );
        citiesResult = { ok: true, date, action, total_cities: cities.length, top: cities.slice(0, 5) };
      } else {
        citiesResult = { ok: true, total_cities: 0, message: "Windsor não retornou cidades" };
      }
    } catch (e) {
      console.error("windsor-instagram cidades:", e);
      citiesResult = { ok: false, error: String((e as Error)?.message ?? e) };
    }

    return new Response(
      JSON.stringify({ ok: true, days_returned: dates, flow_days: flowDays, saved, cities: citiesResult }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("windsor-instagram erro:", e);
    return new Response(
      JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
