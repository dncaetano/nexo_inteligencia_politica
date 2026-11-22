// Ranking Digital Político.
// Lê de intelligence_snapshots (period='ranking_politico') o snapshot
// mais recente coletado pelo Edge Function ranking-politico-scraper.
(function () {
  async function getRankingPolitico(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return null;

    var res = await sb
      .from('intelligence_snapshots')
      .select('metrics, created_at')
      .eq('campaign_id', campaignId)
      .eq('period', 'ranking_politico')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (res.error) throw res.error;
    if (!res.data || !res.data.metrics) return null;

    var m = res.data.metrics;
    return {
      date: m.date || null,
      collected_at: m.collected_at || res.data.created_at,
      interacoes: m.interacoes || [],
      seguidores: m.seguidores || [],
      engajamento: m.engajamento || [],
      mais_postagens: m.mais_postagens || [],
      menos_interacoes: m.menos_interacoes || [],
      menos_seguidores: m.menos_seguidores || [],
      top_posts: m.top_posts || [],
    };
  }

  window.NexoServices = window.NexoServices || {};
  Object.assign(window.NexoServices, {
    getRankingPolitico,
  });
})();
