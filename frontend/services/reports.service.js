// Relatórios (tabela "reports"), mais recentes primeiro.
// Hoje o Intelligence Engine só produz um cadência (report_type
// 'intelligence_daily'), então diário/semanal/mensal na UI vira
// uma janela de tempo sobre created_at, não uma categoria real.
(function () {
  async function getReports(campaignId, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var res = await sb
      .from('reports')
      .select('id,title,report_type,created_at')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(limit || 100);
    if (res.error) throw res.error;
    return res.data || [];
  }

  // Busca sob demanda os relatórios de uma janela (ex.: últimos 7 dias) já
  // com o campo content parseado. Usado na exportação do resumo semanal em PDF,
  // para não inflar o carregamento inicial (getReports traz só metadados).
  async function getReportsSince(campaignId, sinceIso, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var res = await sb
      .from('reports')
      .select('id,title,report_type,created_at,content')
      .eq('campaign_id', campaignId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(limit || 60);
    if (res.error) throw res.error;
    return (res.data || []).map(function (r) {
      return Object.assign({}, r, {
        content: window.NexoServices.parseMaybeJSON(r.content, {}) || {},
      });
    });
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.getReports = getReports;
  window.NexoServices.getReportsSince = getReportsSince;
})();
