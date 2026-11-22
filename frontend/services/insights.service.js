// Insights/IA estratégica.
// Não existe tabela "insights": o conteúdo (summary, insights,
// recommendations, sentiment_analysis, top_entities, agenda_suggestions...)
// vem do último relatório gerado pelo Intelligence Engine (reports.content),
// que é jsonb contendo uma STRING JSON (JSON.stringify no workflow).
(function () {
  async function getLatestReport(campaignId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return null;
    var res = await sb
      .from('reports')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) return null;
    var content = window.NexoServices.parseMaybeJSON(res.data.content, {}) || {};
    return Object.assign({}, res.data, { content: content });
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.getLatestReport = getLatestReport;
})();
