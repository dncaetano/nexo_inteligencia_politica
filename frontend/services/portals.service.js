// Perfis Monitorados (portais de imprensa via RSS).
// Fonte real: monitored_entities (entity_type='portal') + estado da coleta
// em portal_feeds (escrito pela Edge Function portal-news-monitor) + as
// próprias menções coletadas em mentions (source='portal_rss').
// Agente independente do news collector do n8n: não lê nem escreve nada
// relacionado a ele.
(function () {
  async function getMonitoredPortals(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];

    var ents = await sb
      .from('monitored_entities')
      .select('id, name, instagram_url, website_url')
      .eq('campaign_id', campaignId)
      .eq('entity_type', 'portal')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (ents.error) throw ents.error;
    var portals = ents.data || [];
    if (!portals.length) return [];

    var ids = portals.map(function (p) { return p.id; });
    var feeds = await sb
      .from('portal_feeds')
      .select('entity_id, feed_url, feed_status, last_checked_at, last_error')
      .in('entity_id', ids);
    if (feeds.error) throw feeds.error;
    var feedByEntity = {};
    (feeds.data || []).forEach(function (f) { feedByEntity[f.entity_id] = f; });

    // As menções não têm entity_id (o portal cobre o veículo, não uma
    // entidade específica) — o vínculo com o portal é metadata.source_name,
    // que a Edge Function grava como o próprio domínio cadastrado aqui.
    // Só monitoramento: sem sentimento, sem análise de IA.
    var mens = await sb
      .from('mentions')
      .select('published_at, metadata')
      .eq('campaign_id', campaignId)
      .eq('source', 'portal_rss');
    if (mens.error) throw mens.error;

    var stats = {};
    (mens.data || []).forEach(function (m) {
      var meta = window.NexoServices.parseMaybeJSON(m.metadata, {}) || {};
      var domain = meta.source_name;
      if (!domain) return;
      var s = stats[domain] || (stats[domain] = { total: 0, lastMention: null });
      s.total++;
      if (!s.lastMention || (m.published_at && m.published_at > s.lastMention)) s.lastMention = m.published_at;
    });

    return portals.map(function (p) {
      var feed = feedByEntity[p.id] || null;
      var s = stats[p.name] || { total: 0, lastMention: null };
      return {
        id: p.id,
        domain: p.name,
        instagramUrl: p.instagram_url,
        websiteUrl: p.website_url,
        feedUrl: feed ? feed.feed_url : null,
        feedStatus: feed ? feed.feed_status : 'unchecked',
        lastCheckedAt: feed ? feed.last_checked_at : null,
        lastError: feed ? feed.last_error : null,
        mentions: s.total,
        lastMentionAt: s.lastMention,
      };
    }).sort(function (a, b) { return b.mentions - a.mentions || a.domain.localeCompare(b.domain); });
  }

  window.NexoServices = window.NexoServices || {};
  Object.assign(window.NexoServices, {
    getMonitoredPortals,
  });
})();
