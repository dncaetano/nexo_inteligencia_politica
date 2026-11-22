// Notícias/menções (tabela "mentions").
// Não existe tabela "news" nem coluna "topic": o mais próximo é
// metadata.principais_temas (gerado pela IA do News Collector).
// A busca por texto e a paginação são feitas em memória porque o
// filtro por tema depende de um array dentro de metadata (jsonb).
(function () {
  function hostnameOf(url) {
    try {
      var h = new URL(url).hostname.replace(/^www\./, '');
      return h || null;
    } catch (e) {
      return null;
    }
  }

  // Nome de provedor, não de veículo: quando o coletor manda um desses em
  // source_name, o hostname da URL diz mais.
  var FONTES_GENERICAS = [
    '', 'gnews', 'serpapi', 'newsapi', 'google news', 'google notícias',
    'news', 'rss', 'unknown', 'desconhecido',
  ];

  // Chave para contar veículos distintos. O nome exibido não serve: a mesma
  // casa chega ora como "JornalDaSerra", ora como "jornaldaserra.com", conforme o
  // coletor que gravou — e contaria duas vezes.
  function chaveDaFonte(nome) {
    return String(nome || '')
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/(?:combr|com|br)$/, '');
  }

  function normalizeMention(row) {
    var meta = window.NexoServices.parseMaybeJSON(row.metadata, {}) || {};
    var host = hostnameOf(row.url);
    var declarada = String(meta.source_name || '').trim();
    // O veículo declarado pelo coletor vem primeiro; o hostname só entra quando
    // ele falta ou é nome de provedor. A ordem era a inversa, e desde que o
    // coletor passou a usar o RSS do Google News o hostname das matérias novas
    // é sempre news.google.com — que aparecia no lugar de "O GLOBO".
    var source = FONTES_GENERICAS.indexOf(declarada.toLowerCase()) < 0
      ? declarada
      : (host || 'Fonte desconhecida');
    var srcH = source.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '--';
    var sentMap = { positive: 'pos', neutral: 'neu', negative: 'neg' };
    var impMap = { low: 'baixo', medium: 'medio', high: 'alto', critical: 'critico' };
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      source: source,
      sourceKey: chaveDaFonte(source),
      platform: row.source, // fonte crua do banco ('news', 'facebook', ...) p/ cruzar dados
      srcH: srcH,
      date: row.published_at,
      entityId: row.entity_id || null,
      entityType: meta.entity_type || null, // 'candidate' | 'opponent' | ...
      entityName: meta.entity_name || null,
      sent: sentMap[row.sentiment] || 'neu',
      imp: impMap[meta.criticidade] || 'medio',
      temas: Array.isArray(meta.principais_temas) ? meta.principais_temas : [],
      reach: null, // não há métrica de alcance coletada hoje
    };
  }

  // O News/Meta Collector tenta upsert por (entity_id, url), mas falta o índice
  // único correspondente no banco — enquanto isso não é criado, a mesma notícia
  // pode ser inserida várias vezes a cada ciclo de coleta. Deduplicamos aqui na
  // leitura (mantendo a ocorrência mais recente de cada URL) pra não repetir na tela.
  function dedupeByUrl(rows) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      // Chave espelha o conflito do upsert (entity_id, url): a mesma matéria pode
      // existir legitimamente para entidades diferentes (candidato E adversário).
      var key = (rows[i].entity_id || '') + '|' + (rows[i].url || rows[i].id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rows[i]);
    }
    return out;
  }

  async function getMentions(campaignId, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var res = await sb
      .from('mentions')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('published_at', { ascending: false })
      .limit(limit || 200);
    if (res.error) throw res.error;
    return dedupeByUrl(res.data || []).map(normalizeMention);
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.getMentions = getMentions;
})();
