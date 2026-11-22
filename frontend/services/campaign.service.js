// Campanha ativa (contexto usado por todos os demais services).
(function () {
  async function getActiveCampaign() {
    var sb = window.NexoServices.getClient();
    if (!sb) return null;
    var res = await sb
      .from('campaigns')
      .select('id,name,candidate_name,client_name,target_region')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (res.error) throw res.error;
    return res.data;
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.getActiveCampaign = getActiveCampaign;
})();
