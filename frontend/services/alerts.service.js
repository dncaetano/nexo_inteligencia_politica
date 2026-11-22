// Alertas (tabela "alerts"), mais recentes primeiro.
(function () {
  async function getAlerts(campaignId, limit) {
    var sb = window.NexoServices.getClient();
    if (!sb || !campaignId) return [];
    var res = await sb
      .from('alerts')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(limit || 50);
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function resolveAlert(alertId) {
    var sb = window.NexoServices.getClient();
    if (!sb || !alertId) return null;
    var res = await sb
      .from('alerts')
      .update({ status: 'resolved', read: true })
      .eq('id', alertId)
      .select()
      .maybeSingle();
    if (res.error) throw res.error;
    return res.data;
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.getAlerts = getAlerts;
  window.NexoServices.resolveAlert = resolveAlert;
})();
