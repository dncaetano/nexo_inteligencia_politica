// Coletor dos COMENTÁRIOS das publicações do candidato via Windsor.ai.
//
// É a única fonte de texto de comentário que temos: o conector público
// (windsor-instagram-public) só devolve CONTAGEM (comments_per_post), e a
// tabela mentions só recebe imprensa. O report 'comments' do conector
// /instagram existe porque a conta é a nossa — comentários de perfis de
// terceiros não são acessíveis.
//
// Faz DUAS chamadas ao Windsor. A API aceita um "report" por request: pedir
// comment_* junto com media_* faz o join do lado deles e devolve linha
// repetida/agregada de forma imprevisível. Então:
//   1. /instagram fields=comment_*  → uma linha por COMENTÁRIO
//   2. /instagram fields=media_*    → uma linha por POST (caption, permalink)
// e o casamento é feito aqui, por media_id.
//
// Grava period='instagram_comments' em intelligence_snapshots, uma linha por
// dia de coleta, com metrics.posts = [{post, comments[]}]. Não cria tabela
// nova de propósito: a RLS de intelligence_snapshots já entrega o dado ao
// frontend pela campanha, e o volume é pequeno (ver MAX_POSTS/MAX_COMENTARIOS).
//
// Secrets (compartilhados com as outras funções windsor-*):
//   WINDSOR_API_KEY, CRON_SECRET.
//   WINDSOR_COMMENTS_DIAS opcional (default 7).
//
// Chamar com ?dry=1 devolve o que veio do Windsor sem gravar nada; ?dias=
// muda a janela só naquela chamada.
import { createClient } from "jsr:@supabase/supabase-js@2";

const WINDSOR_INSTAGRAM = "https://connectors.windsor.ai/instagram";

// Report 'comments'. A API do Windsor não expõe o AUTOR do comentário (não há
// campo username/from), só o texto e os números — por isso a UI mostra o
// comentário sem identificação de quem escreveu.
const COMMENT_FIELDS = [
  "date",
  "media_id",
  "comment_id",
  "comment_text",
  "comment_timestamp",
  "comment_like_count",
  "comment_reply_count",
  "comment_parent_id",
];

// Report 'media_info': o post a que o comentário pertence.
const MEDIA_FIELDS = [
  "media_id",
  "media_caption",
  "media_permalink",
  "media_type",
  "media_product_type",
  "media_url",
  "media_thumbnail_url",
  "media_like_count",
  "media_comments_count",
  "timestamp",
];

// Tetos de tamanho do jsonb. Uma publicação com muito engajamento passa de mil
// comentários; guardar tudo incharia a linha do snapshot sem servir à leitura,
// que é qualitativa. Ficamos com os posts mais recentes e, dentro de cada um,
// com os comentários mais recentes.
const MAX_POSTS = 12;
const MAX_COMENTARIOS = 40;
const MAX_TEXTO = 500;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function txt(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

// Corta a string SEM partir emoji ao meio.
//
// Um emoji ocupa dois caracteres em JavaScript (par surrogate). Um slice cru
// pode cair entre os dois e deixar meio emoji solto — o que produz um JSON
// inválido em UTF-8, e o PostgREST recusa o update inteiro com HTTP 400. Foi
// isso que travou a gravação deste coletor: comentário de Instagram é quase só
// emoji, então o corte em 500 caracteres cedo ou tarde cai no lugar errado.
function cortar(s: string, n: number): string {
  if (s.length <= n) return s;
  let fim = n;
  const c = s.charCodeAt(fim - 1);
  if (c >= 0xD800 && c <= 0xDBFF) fim--; // não termina em metade de emoji
  return s.slice(0, fim);
}

// Rede de segurança para o mesmo problema vindo de fora: surrogate solto que já
// veio quebrado da fonte, e NUL, que o Postgres não aceita em jsonb.
function sanear(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1")
    .replace(/\u0000/g, "");
}

// O Windsor sinaliza erro de cota/plano com HTTP 200 e o texto do erro dentro
// dos campos da linha ("Uh-oh! You've connected more accounts than your Free
// plan allows..."), em vez de um status de erro. Sem esta guarda, a mensagem
// entrava no snapshot como se fosse uma publicação com um comentário.
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

function linhaDeErro(r: Record<string, unknown>): boolean {
  return Object.values(r).some(pareceErro);
}

// O runtime mata a função por volta dos 150s. Pedir a janela inteira de uma vez
// não cabe: nem last_30d nem last_7d voltaram a tempo — um único post do
// candidato passa de mil comentários. A saída é a mesma do coletor de perfis
// públicos: quebrar em requests pequenos (aqui, UM DIA cada), limitar linhas com
// _max_rows e rodar alguns em paralelo. Um dia que estoura não leva os outros
// junto, e a próxima rodada do cron pega esse dia do cache do Windsor, que
// serve de graça o que já foi buscado uma vez.
// Timeout generoso por dia: um dia que ainda não está no cache do Windsor leva
// bem mais que os demais, e abortar cedo demais é contraproducente — a chamada
// interrompida não deixa nada no cache, então a rodada seguinte é igualmente
// lenta e o dia nunca entra. Deixando terminar uma vez, as próximas voltam em
// segundos. Os dias vêm do mais recente para o mais antigo, e o orçamento total
// nunca é ultrapassado (o timeout de cada request é limitado pelo que resta).
const TIMEOUT_DIA_MS = 100_000;
const CONCORRENCIA = 6;
// A busca cede espaço para a classificação: as duas etapas juntas precisam
// caber nos ~150s de vida da função (ver ORCAMENTO_IA_MS).
const ORCAMENTO_MS = 80_000;
const ORCAMENTO_IA_MS = 125_000;
const TIMEOUT_MINIMO_MS = 5_000;
const MAX_ROWS = 500;

// Um request do Windsor, filtrado por intervalo de datas em vez de date_preset:
// é o que permite pedir um dia de cada vez.
async function buscar(
  apiKey: string,
  fields: string[],
  from: string,
  to: string,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const url = new URL(WINDSOR_INSTAGRAM);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("date_from", from);
  url.searchParams.set("date_to", to);
  url.searchParams.set("fields", fields.join(","));
  url.searchParams.set("_max_rows", String(MAX_ROWS));
  url.searchParams.set("_renderer", "json");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url.toString(), { signal: ctrl.signal });
    const body = await resp.text();
    if (!resp.ok) {
      // Nunca deixar a chave vazar na mensagem de erro.
      throw new Error(
        `Windsor respondeu ${resp.status}: ${body.split(apiKey).join("***").slice(0, 400)}`,
      );
    }
    const json = JSON.parse(body);
    const linhas: Record<string, unknown>[] = Array.isArray(json?.data) ? json.data : [];
    // Descarta as linhas que são, na verdade, mensagem de erro do Windsor.
    const limpas = linhas.filter((r) => !linhaDeErro(r));
    if (!limpas.length && linhas.length) {
      throw new Error("Windsor devolveu erro de plano no lugar dos dados");
    }
    return limpas;
  } finally {
    clearTimeout(t);
  }
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

function diasAtras(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Sentimento dos comentários, com IA
//
// A primeira versão classificava por léxico no frontend — palavras e emojis com
// peso. Funcionava para "👏👏 2️⃣2️⃣" e para xingamento explícito, mas errava
// justamente onde comentário político é difícil: ironia ("Sei, kkkkkk"),
// deboche sem palavrão ("Você não ganha nem pra ser gari"), e crítica a
// adversário dentro de um comentário de apoio.
//
// Agora quem classifica é o mesmo gpt-4o-mini do coletor de notícias, em LOTE:
// um request por bloco de comentários, e não um por comentário — o que torna o
// custo desprezível. Comentário já classificado nunca é reclassificado: o
// campo sentiment vem junto no merge e a rodada seguinte só olha os novos.
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
// Modelo escolhido por CUSTO: classificar comentário é tarefa curta e
// repetitiva, não precisa de um modelo caro. Este custa US$ 0,10 por milhão de
// tokens de entrada — um terço do gpt-4o-mini — e dá conta de ironia em
// português, que era o buraco do léxico. Trocável pelo secret
// WINDSOR_COMMENTS_MODELO, sem mexer no código.
//
// O ID precisa existir no catálogo do OpenRouter: um nome inventado volta como
// 404 "No endpoints found" e a rodada inteira fica sem classificar. Confira em
// https://openrouter.ai/api/v1/models antes de trocar.
const MODELO_PADRAO = "google/gemini-2.5-flash-lite";
// Lote grande dilui o prompt fixo: são ~350 tokens de instrução para 40
// comentários em vez de para 1. É o que faz o custo por comentário despencar.
const LOTE_IA = 40;
const MAX_CLASSIFICAR_POR_RODADA = 160;
const MAX_TEXTO_IA = 180;
const TIMEOUT_IA_MS = 30_000;
const CONCORRENCIA_IA = 3;

// Lê secret sem depender da caixa do nome: o painel do Supabase aceita
// "openrouter_api_key" e Deno.env é sensível a maiúsculas.
function env(nome: string): string | undefined {
  return Deno.env.get(nome) ?? Deno.env.get(nome.toLowerCase()) ??
    Deno.env.get(nome.toUpperCase());
}

const SENTIMENTOS = new Set(["pos", "neu", "neg"]);

async function classificarLote(
  apiKey: string,
  candidato: string,
  legenda: string,
  comentarios: Comentario[],
): Promise<Map<string, string>> {
  const lista = comentarios
    .map((c, i) => `${i}|${cortar(c.text.replace(/\s+/g, " "), MAX_TEXTO_IA)}`)
    .join("\n");

  // O que este prompt precisa acertar é o ALVO, não o tom — e é aí que estava
  // o erro. Num post que ataca um adversário ("Nelson Reis continua tentando enganar o
  // povo"), a maioria dos comentários ofensivos ecoa o ataque: "isso é
  // senilidade", "mentiroso", "kkkk", "é verdade". Lidos isoladamente parecem
  // negativos; lidos junto com a legenda, são apoio ao candidato. Por isso a
  // legenda vem antes dos comentários e com mais espaço (220 caracteres), e a
  // regra do alvo aparece explicitamente.
  const prompt = `Perfil de ${candidato}. LEGENDA DO POST: "${cortar(legenda, 220)}"

Classifique cada comentário pelo que ele significa PARA ${candidato}:
pos = apoio a ${candidato} (elogio, voto, "22", 👏, 🇧🇷) OU concordar com a legenda OU atacar quem a legenda ataca
neg = crítica, xingamento, ironia ou deboche DIRIGIDOS A ${candidato}
neu = pergunta, desabafo, comentário sem posição, spam

O ALVO importa mais que o tom. Leia a legenda antes:
- Se a legenda ataca ou critica outra pessoa (ex.: um adversário), os comentários
  ofensivos SEM dizer o nome ("mentiroso", "ladrão", "isso é senilidade", "cadeia
  nele", "kkkk", "é verdade") estão falando do alvo da legenda — isso é pos.
- Só marque neg quando a ofensa for claramente contra ${candidato}.
- Xingar Nelson Reis, PT, esquerda ou qualquer adversário é sempre pos.
- Bandido/cadeia/prisão é a pauta de segurança dele: só neg se o alvo for ${candidato}.

${lista}

JSON: {"r":[{"i":0,"s":"pos"}]} — um item por comentário, mesma numeração.`;

  const resp = await comTimeout(OPENROUTER, TIMEOUT_IA_MS, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env("WINDSOR_COMMENTS_MODELO") || MODELO_PADRAO,
      temperature: 0,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Classifica comentários de Instagram de perfis políticos brasileiros. " +
            "Responde APENAS JSON válido.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const body = await resp.text();
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${body.slice(0, 200)}`);

  const json = JSON.parse(body);
  const bruto = txt(json?.choices?.[0]?.message?.content)
    .replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(bruto);
  const itens = Array.isArray(parsed?.r) ? parsed.r : [];

  const saida = new Map<string, string>();
  for (const item of itens) {
    const i = Number(item?.i);
    const s = txt(item?.s).toLowerCase();
    const alvo = comentarios[i];
    if (alvo && SENTIMENTOS.has(s)) saida.set(alvo.id, s);
  }
  return saida;
}

// Percorre os posts, junta os comentários ainda sem sentimento e classifica em
// lotes. Devolve quantos foram classificados; o que não coube fica para a
// próxima rodada do cron.
async function classificarPendentes(
  apiKey: string,
  candidato: string,
  posts: PostComentado[],
  inicio: number,
  orcamentoMs: number,
  // ?reclassificar=1 ignora o que já foi classificado. Serve para quando o
  // prompt muda: sem isso, o histórico ficaria com a régua antiga para sempre.
  reclassificar = false,
): Promise<{ classificados: number; falhas: string[] }> {
  type Pendente = { post: PostComentado; comentario: Comentario };
  const pendentes: Pendente[] = [];
  for (const p of posts) {
    for (const c of p.comments) {
      if (reclassificar || !c.sentiment) pendentes.push({ post: p, comentario: c });
    }
  }
  if (!pendentes.length) return { classificados: 0, falhas: [] };

  // Lotes por publicação: a legenda entra como contexto, e misturar posts
  // diferentes no mesmo lote tiraria isso.
  const lotes: Pendente[][] = [];
  const porPost = new Map<string, Pendente[]>();
  for (const p of pendentes.slice(0, MAX_CLASSIFICAR_POR_RODADA)) {
    const chave = p.post.media_id;
    if (!porPost.has(chave)) porPost.set(chave, []);
    porPost.get(chave)!.push(p);
  }
  for (const grupo of porPost.values()) {
    for (let i = 0; i < grupo.length; i += LOTE_IA) {
      lotes.push(grupo.slice(i, i + LOTE_IA));
    }
  }

  let classificados = 0;
  const falhas: string[] = [];
  let proximo = 0;

  const worker = async () => {
    while (proximo < lotes.length) {
      if (Date.now() - inicio > orcamentoMs) return;
      const lote = lotes[proximo++];
      try {
        const mapa = await classificarLote(
          apiKey,
          candidato,
          lote[0].post.caption,
          lote.map((x) => x.comentario),
        );
        for (const { comentario } of lote) {
          const s = mapa.get(comentario.id);
          if (s) {
            comentario.sentiment = s;
            classificados++;
          }
        }
      } catch (e) {
        falhas.push(String((e as Error)?.message ?? e).split(apiKey).join("***").slice(0, 200));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA_IA, lotes.length) }, worker),
  );

  return { classificados, falhas };
}

type Comentario = {
  id: string;
  text: string;
  timestamp: string;
  likes: number;
  replies: number;
  is_reply: boolean;
  // 'pos' | 'neu' | 'neg', preenchido pela IA. Ausente = ainda não classificado
  // (comentário gravado antes desta versão, ou que não coube na rodada).
  sentiment?: string;
};

type PostComentado = {
  media_id: string;
  caption: string;
  permalink: string;
  media_type: string;
  product_type: string;
  thumb: string;
  likes: number;
  comments_count: number;
  timestamp: string;
  comments_total: number;
  comments_coletados: number;
  comments: Comentario[];
};

// Soma a coleta nova ao que já estava gravado. Metadado do post (curtidas,
// contagem, thumb) vem do mais novo; comentários são unidos por id, porque a
// mesma publicação aparece em coletas de dias diferentes com comentários
// diferentes. Os cortes (MAX_POSTS/MAX_COMENTARIOS) são aplicados só aqui, no
// fim, para que o teto valha sobre o acumulado e não sobre cada rodada.
function mesclarPosts(antigos: PostComentado[], novos: PostComentado[]): PostComentado[] {
  const porId = new Map<string, PostComentado>();

  for (const p of [...antigos, ...novos]) {
    if (!p || !p.media_id) continue;
    const atual = porId.get(p.media_id);
    if (!atual) {
      porId.set(p.media_id, {
        ...p,
        caption: sanear(txt(p.caption)),
        comments: (p.comments || []).map((c) => ({ ...c, text: sanear(txt(c.text)) })),
      });
      continue;
    }
    const comentarios = new Map<string, Comentario>();
    for (const c of [...(atual.comments || []), ...(p.comments || [])]) {
      if (!c || !c.id) continue;
      // O mesmo comentário volta em coletas diferentes SEM o sentimento (a
      // fonte não o conhece). Sem esta linha, a versão nova apagaria a
      // classificação e a IA pagaria de novo pelo mesmo texto.
      const anterior = comentarios.get(c.id);
      comentarios.set(c.id, {
        ...c,
        // Sanear também na leitura: o snapshot já gravado pode carregar meio
        // emoji de antes da correção, e ele voltaria a quebrar a gravação.
        text: sanear(txt(c.text)),
        sentiment: c.sentiment ?? anterior?.sentiment,
      });
    }
    porId.set(p.media_id, {
      ...atual,
      // O post que chega depois é o mais novo: caption e números dele ganham,
      // mas nunca zeram o que já existia (uma rodada sem o report media_info
      // deixa esses campos vazios).
      caption: p.caption || atual.caption,
      permalink: p.permalink || atual.permalink,
      media_type: p.media_type || atual.media_type,
      product_type: p.product_type || atual.product_type,
      thumb: p.thumb || atual.thumb,
      likes: Math.max(p.likes || 0, atual.likes || 0),
      comments_count: Math.max(p.comments_count || 0, atual.comments_count || 0),
      timestamp: p.timestamp || atual.timestamp,
      comments: [...comentarios.values()],
    });
  }

  return [...porId.values()]
    .map((p) => {
      const comments = p.comments
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
        .slice(0, MAX_COMENTARIOS);
      return {
        ...p,
        comments,
        comments_coletados: comments.length,
        comments_total: Math.max(p.comments_count || 0, comments.length),
      };
    })
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, MAX_POSTS);
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

  const qs = new URL(req.url).searchParams;
  // Quantos dias para trás coletar. 7 é o que cabe no tempo da função com folga;
  // aumentar exige ou mais concorrência ou aceitar coleta parcial (os dias que
  // não couberem no orçamento voltam como "pulados").
  const janelaDias = Math.max(
    1,
    Math.min(30, Number(qs.get("dias") || Deno.env.get("WINDSOR_COMMENTS_DIAS") || 7)),
  );
  const dry = qs.get("dry") === "1";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // 1. Buscar comentários e posts, um dia por request
    // Os dois reports entram na MESMA fila de dias: assim o orçamento de tempo
    // é compartilhado e nenhum dos dois monopoliza a função.
    const inicio = Date.now();
    const dias = Array.from({ length: janelaDias }, (_, i) => diasAtras(i));

    const tarefas = dias.flatMap((dia) => [
      { dia, fields: COMMENT_FIELDS, tipo: "comments" as const },
      { dia, fields: MEDIA_FIELDS, tipo: "media" as const },
    ]);

    const comentarioRows: Record<string, unknown>[] = [];
    const mediaRows: Record<string, unknown>[] = [];
    const falhas: { dia: string; tipo: string; erro: string }[] = [];
    const pulados: { dia: string; tipo: string }[] = [];
    let proximo = 0;

    const worker = async () => {
      while (proximo < tarefas.length) {
        const restante = ORCAMENTO_MS - (Date.now() - inicio);
        if (restante < TIMEOUT_MINIMO_MS) {
          while (proximo < tarefas.length) {
            const t = tarefas[proximo++];
            pulados.push({ dia: t.dia, tipo: t.tipo });
          }
          return;
        }
        const t = tarefas[proximo++];
        try {
          const rows = await buscar(
            apiKey, t.fields, t.dia, t.dia, Math.min(TIMEOUT_DIA_MS, restante),
          );
          (t.tipo === "comments" ? comentarioRows : mediaRows).push(...rows);
        } catch (e) {
          falhas.push({
            dia: t.dia,
            tipo: t.tipo,
            erro: String((e as Error)?.message ?? e).split(apiKey).join("***"),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCORRENCIA, tarefas.length) }, worker),
    );

    if (dry) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry: true,
          janelaDias,
          duracao_ms: Date.now() - inicio,
          falhas,
          pulados,
          comentarios: {
            linhas: comentarioRows.length,
            amostra: comentarioRows.slice(0, 3),
          },
          posts: {
            linhas: mediaRows.length,
            amostra: mediaRows.slice(0, 2),
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 2. Indexar os posts por media_id
    // O report media_info repete a mesma publicação em várias linhas (uma por
    // dia da janela); ficamos com a versão de maior contagem, que é a mais nova.
    const posts: Record<string, {
      media_id: string;
      caption: string;
      permalink: string;
      media_type: string;
      product_type: string;
      thumb: string;
      likes: number;
      comments_count: number;
      timestamp: string;
    }> = {};

    for (const r of mediaRows) {
      const id = txt(r["media_id"]);
      if (!id) continue;
      const thumb = txt(r["media_thumbnail_url"]) || txt(r["media_url"]);
      const atual = posts[id];
      const novo = {
        media_id: id,
        caption: sanear(cortar(txt(r["media_caption"]), 600)),
        permalink: txt(r["media_permalink"]),
        media_type: txt(r["media_type"]),
        product_type: txt(r["media_product_type"]),
        thumb,
        likes: num(r["media_like_count"]),
        comments_count: num(r["media_comments_count"]),
        timestamp: txt(r["timestamp"]),
      };
      if (!atual || novo.comments_count >= atual.comments_count) {
        posts[id] = { ...novo, thumb: novo.thumb || atual?.thumb || "" };
      }
    }

    // 3. Agrupar os comentários por post
    const porPost: Record<string, Map<string, Comentario>> = {};
    let semTexto = 0;
    let semPost = 0;

    for (const r of comentarioRows) {
      const texto = txt(r["comment_text"]);
      if (!texto) { semTexto++; continue; }
      const mediaId = txt(r["media_id"]);
      if (!mediaId) { semPost++; continue; }
      const id = txt(r["comment_id"]) || `${mediaId}:${texto.slice(0, 40)}`;
      // Deduplica: a janela de datas devolve o mesmo comentário em dias
      // diferentes quando ele é contado mais de uma vez.
      const mapa = (porPost[mediaId] ||= new Map());
      mapa.set(id, {
        id,
        text: sanear(cortar(texto, MAX_TEXTO)),
        timestamp: txt(r["comment_timestamp"]) || txt(r["date"]),
        likes: num(r["comment_like_count"]),
        replies: num(r["comment_reply_count"]),
        is_reply: !!txt(r["comment_parent_id"]),
      });
    }

    // 4. Montar a lista desta coleta
    // Só posts que têm comentário com texto: um card de publicação vazio não
    // acrescenta nada à aba, que já mostra os números por outro caminho.
    const coletados: PostComentado[] = Object.keys(porPost).map((mediaId) => {
      const comentarios = [...porPost[mediaId].values()];
      const post = posts[mediaId] || {
        media_id: mediaId,
        caption: "",
        permalink: "",
        media_type: "",
        product_type: "",
        thumb: "",
        likes: 0,
        comments_count: 0,
        timestamp: comentarios[0]?.timestamp || "",
      };
      return {
        ...post,
        // Quantos existem de fato no Instagram vs. quantos guardamos aqui.
        comments_total: post.comments_count || comentarios.length,
        comments_coletados: comentarios.length,
        comments: comentarios,
      };
    });

    // 5. Campanha ativa
    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id, candidate_name, name")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) throw new Error("Nenhuma campanha ativa encontrada");

    // 6. Mesclar com o que já havia
    // A coleta é parcial por natureza (dias que estouram o timeout voltam na
    // rodada seguinte), então substituir o snapshot apagaria comentários que já
    // tínhamos. Partimos sempre da coleta anterior mais recente e somamos.
    const { data: anterior, error: aErr } = await supabase
      .from("intelligence_snapshots")
      .select("id, metrics")
      .eq("campaign_id", campaign.id)
      .eq("period", "instagram_comments")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (aErr) throw aErr;

    const antigos = Array.isArray((anterior?.metrics as Record<string, unknown>)?.posts)
      ? ((anterior!.metrics as Record<string, unknown>).posts as PostComentado[])
      : [];

    const lista = mesclarPosts(antigos, coletados);

    // 6b. Classificar o que ainda não tem sentimento
    // Roda depois do merge para pegar também os comentários gravados antes de
    // esta versão. O que não couber no orçamento fica para a próxima rodada.
    const iaKey = env("OPENROUTER_API_KEY");
    let ia = { classificados: 0, falhas: [] as string[] };
    if (iaKey && lista.length) {
      const candidato = txt(
        (campaign as { candidate_name?: string; name?: string }).candidate_name ||
          (campaign as { name?: string }).name,
      ) || "o candidato";
      ia = await classificarPendentes(
        iaKey, candidato, lista, inicio, ORCAMENTO_IA_MS,
        qs.get("reclassificar") === "1",
      );
    }
    const semSentimento = lista.reduce(
      (n, p) => n + p.comments.filter((c) => !c.sentiment).length,
      0,
    );

    if (!lista.length) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "Nenhum comentário com texto retornado pelo Windsor",
          linhasComentarios: comentarioRows.length,
          linhasPosts: mediaRows.length,
          semTexto,
          semPost,
          falhas,
          pulados,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 7. Gravar
    // Uma linha por dia de coleta: o histórico de dias fica preservado e a aba
    // lê sempre a mais recente.
    const hoje = new Date().toISOString().slice(0, 10);
    const metrics = {
      source: "instagram_comments",
      provider: "windsor",
      date: hoje,
      window: `${janelaDias}d`,
      collected_at: new Date().toISOString(),
      posts_count: lista.length,
      comments_count: lista.reduce((s, p) => s + p.comments.length, 0),
      posts: lista,
    };

    const { data: existing, error: sErr } = await supabase
      .from("intelligence_snapshots")
      .select("id")
      .eq("campaign_id", campaign.id)
      .eq("period", "instagram_comments")
      .eq("metrics->>date", hoje)
      .limit(1)
      .maybeSingle();
    if (sErr) throw sErr;

    if (existing) {
      const { error } = await supabase
        .from("intelligence_snapshots")
        .update({ metrics })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("intelligence_snapshots")
        .insert({ campaign_id: campaign.id, period: "instagram_comments", metrics });
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        date: hoje,
        action: existing ? "updated" : "inserted",
        posts: metrics.posts_count,
        comentarios: metrics.comments_count,
        novosNestaRodada: coletados.reduce((s, p) => s + p.comments.length, 0),
        linhasComentarios: comentarioRows.length,
        linhasPosts: mediaRows.length,
        semTexto,
        semPost,
        classificados_ia: ia.classificados,
        sem_sentimento: semSentimento,
        falhas_ia: ia.falhas,
        falhas,
        pulados,
        duracao_ms: Date.now() - inicio,
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
