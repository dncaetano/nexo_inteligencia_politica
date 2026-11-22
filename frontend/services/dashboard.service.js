// Indicadores do Dashboard.
// Fonte real: intelligence_snapshots (scores 0-100 já calculados pelo
// Intelligence Engine) + contagens em alerts/monitored_entities.
// Não existe tabela "dashboard_cache" — os snapshots já cumprem esse papel.
(function () {
  // sinceIso filtra por created_at >= data (janela de 7/30/90 dias no seletor
  // do dashboard). Sem sinceIso, mantém o comportamento antigo (só limita
  // por quantidade de linhas).
  async function getSnapshotHistory(campaignId, sinceIso, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    // period='24h' isola os snapshots do Intelligence Engine das linhas de
    // outras fontes (ex.: period='instagram', gravadas pelo coletor Windsor),
    // que têm scores zerados e quebrariam os gráficos de sentimento.
    var query = sb
      .from('intelligence_snapshots')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('period', '24h');
    if (sinceIso) query = query.gte('created_at', sinceIso);
    var res = await query
      .order('created_at', { ascending: false })
      .limit(limit || 500);
    if (res.error) throw res.error;
    return (res.data || []).slice().reverse(); // ordem ascendente p/ gráficos
  }

  // Insights de conta do Instagram coletados de hora em hora pela Edge Function
  // windsor-instagram (period='instagram'). Os números ficam em metrics (jsonb):
  // followers_count, follows_count, media_count, reach, impressions,
  // profile_views, website_clicks, accounts_engaged, date.
  // NÃO filtramos/ordenamos por created_at: as linhas do IG têm created_at fixo
  // (a coleta horária atualiza metrics, não a linha), então uma janela sobre
  // created_at derrubaria todas as linhas depois de alguns dias, sumindo com o
  // card mesmo havendo dados frescos. Buscamos as últimas N linhas e ordenamos
  // pela DATA da métrica (metrics.date). sinceIso é ignorado de propósito.
  async function getInstagramInsights(campaignId, sinceIso, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var res = await sb
      .from('intelligence_snapshots')
      .select('id, created_at, metrics')
      .eq('campaign_id', campaignId)
      .eq('period', 'instagram')
      .order('created_at', { ascending: false })
      .limit(limit || 90);
    if (res.error) throw res.error;
    // metrics pode chegar como objeto (jsonb) ou string JSON (double-encoded).
    var rows = (res.data || []).map(function (row) {
      return Object.assign({}, row, {
        metrics: window.NexoServices.parseMaybeJSON(row.metrics, {}) || {},
      });
    });
    // ordem cronológica ascendente pela data da métrica (p/ sparkline e "último dia").
    rows.sort(function (a, b) {
      return String(a.metrics.date || '').localeCompare(String(b.metrics.date || ''));
    });
    return rows;
  }

  // Conta só os adversários: a UI usa este número como "N concorrentes" e como
  // consumo da cota do plano. Sem o filtro por entity_type ele somava também o
  // próprio candidato e os portais de imprensa monitorados.
  // Audiência do Instagram por cidade (period='instagram_cities'), gravada pela
  // mesma Edge Function em um snapshot próprio. metrics.cities já vem ordenado
  // do maior para o menor. Lemos apenas a coleta mais recente.
  async function getInstagramCities(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return null;
    var res = await sb
      .from('intelligence_snapshots')
      .select('id, created_at, metrics')
      .eq('campaign_id', campaignId)
      .eq('period', 'instagram_cities')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) return null;
    return Object.assign({}, res.data, {
      metrics: window.NexoServices.parseMaybeJSON(res.data.metrics, {}) || {},
    });
  }

  async function getMonitoredEntitiesCount(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return 0;
    var res = await sb
      .from('monitored_entities')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('entity_type', 'opponent')
      .eq('is_active', true);
    if (res.error) throw res.error;
    return res.count || 0;
  }

  // Conta só o que a Central de Alertas mostra: alertas da chapa (Ricardo
  // Lima e Paulo Ferraz). O título vem no formato "<Tipo>: <sujeito>" e
  // nenhum rótulo de tipo contém esses nomes, então o ilike no título equivale
  // a filtrar pelo sujeito do alerta. Sem "flávio" solto para não pegar Flávio
  // Dino; sem acento em "ferraz" para o ilike não depender de diacrítico.
  async function getCriticalAlertsCount(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return 0;
    var res = await sb
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('severity', ['critical', 'high'])
      .eq('read', false)
      .or('title.ilike.%lima%,title.ilike.%ferraz%');
    if (res.error) throw res.error;
    return res.count || 0;
  }

  // Adversários monitorados (entity_type = 'opponent') + volume/sentimento de
  // menções que o News Collector já associou a cada um. Sem join no PostgREST:
  // buscamos as entidades e as menções da campanha e agregamos em memória.
  async function getAdversaries(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var ents = await sb
      .from('monitored_entities')
      .select('id, name, entity_type, instagram_url, facebook_url, youtube_url, website_url')
      .eq('campaign_id', campaignId)
      .eq('entity_type', 'opponent')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (ents.error) throw ents.error;
    var opponents = ents.data || [];
    if (!opponents.length) return [];

    var mens = await sb
      .from('mentions')
      .select('entity_id, sentiment, published_at, metadata')
      .eq('campaign_id', campaignId);
    if (mens.error) throw mens.error;

    var recentCut = Date.now() - 7 * 24 * 3600 * 1000;
    var stats = {};
    (mens.data || []).forEach(function (m) {
      if (!m.entity_id) return;
      var s = stats[m.entity_id] ||
        (stats[m.entity_id] = { total: 0, positive: 0, neutral: 0, negative: 0, recent: 0, impactSum: 0 });
      s.total++;
      if (m.sentiment === 'positive') s.positive++;
      else if (m.sentiment === 'negative') s.negative++;
      else s.neutral++;
      var pub = m.published_at ? Date.parse(m.published_at) : NaN;
      if (!isNaN(pub) && pub >= recentCut) s.recent++;
      // impact_score e relevance_score (0-1) são gravados pela análise de IA do
      // news collector em todas as menções; a média dos dois mede o "peso" da
      // matéria. Sem os campos, cai em 0.5 (neutro) para não punir a entidade.
      var md = m.metadata || {};
      var imp = Number(md.impact_score);
      var rel = Number(md.relevance_score);
      var parts = [];
      if (!isNaN(imp)) parts.push(imp);
      if (!isNaN(rel)) parts.push(rel);
      s.impactSum += parts.length
        ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length
        : 0.5;
    });

    var rows = opponents.map(function (o) {
      var s = stats[o.id] || { total: 0, positive: 0, neutral: 0, negative: 0, recent: 0, impactSum: 0 };
      return {
        id: o.id,
        name: o.name,
        instagram_url: o.instagram_url,
        facebook_url: o.facebook_url,
        youtube_url: o.youtube_url,
        website_url: o.website_url,
        mentions: s.total,
        positive: s.positive,
        neutral: s.neutral,
        negative: s.negative,
        recentMentions: s.recent,
        avgImpact: s.total ? s.impactSum / s.total : 0,
      };
    });

    // Score de exposição (0-100) para ranquear os adversários. Combina volume
    // de notícias, peso editorial médio das matérias e quanto do volume é
    // recente. Não entra engajamento de redes sociais: o sistema não coleta
    // métricas das contas dos adversários, só as da base própria.
    var maxMentions = rows.reduce(function (mx, r) { return Math.max(mx, r.mentions); }, 0);
    rows.forEach(function (r) {
      var volume = maxMentions ? r.mentions / maxMentions : 0;
      var recency = r.mentions ? r.recentMentions / r.mentions : 0;
      r.score = r.mentions
        ? Math.round((volume * 0.45 + r.avgImpact * 0.35 + recency * 0.20) * 100)
        : 0;
    });

    return rows.sort(function (a, b) {
      return b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name);
    });
  }

  // Perfis públicos dos concorrentes (period='instagram_public'), coletados
  // uma vez por dia pela Edge Function windsor-instagram-public. Cada linha é
  // uma coleta e traz metrics.profiles[] com um item por perfil.
  //
  // Devolvemos as últimas coletas em ordem cronológica porque o CRESCIMENTO de
  // seguidores não vem da API: é derivado comparando duas coletas. Com uma
  // única coleta no banco, a coluna fica vazia — é o esperado no primeiro dia.
  async function getInstagramPublic(campaignId, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var res = await sb
      .from('intelligence_snapshots')
      .select('id, created_at, metrics')
      .eq('campaign_id', campaignId)
      .eq('period', 'instagram_public')
      .order('created_at', { ascending: false })
      .limit(limit || 30);
    if (res.error) throw res.error;
    var rows = (res.data || []).map(function (row) {
      return Object.assign({}, row, {
        metrics: window.NexoServices.parseMaybeJSON(row.metrics, {}) || {},
      });
    });
    // Ascendente pela data da métrica: a última posição é a coleta mais nova.
    rows.sort(function (a, b) {
      return String(a.metrics.date || '').localeCompare(String(b.metrics.date || ''));
    });
    return rows;
  }

  // Comentários das publicações do candidato (period='instagram_comments'),
  // coletados pela Edge Function windsor-instagram-comments. Lemos só a coleta
  // mais recente: ela já é ACUMULATIVA (cada rodada soma o que veio de novo ao
  // que a anterior tinha), então a última linha é a mais completa.
  async function getInstagramComments(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return null;
    var res = await sb
      .from('intelligence_snapshots')
      .select('id, created_at, metrics')
      .eq('campaign_id', campaignId)
      .eq('period', 'instagram_comments')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) return null;
    return Object.assign({}, res.data, {
      metrics: window.NexoServices.parseMaybeJSON(res.data.metrics, {}) || {},
    });
  }

  window.NexoServices = window.NexoServices || {};
  Object.assign(window.NexoServices, {
    getSnapshotHistory,
    getInstagramInsights,
    getInstagramCities,
    getInstagramPublic,
    getInstagramComments,
    getMonitoredEntitiesCount,
    getCriticalAlertsCount,
    getAdversaries,
  });
})();
