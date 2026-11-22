// Chat (IA Estratégica) via webhook do workflow n8n
// "Strategic Assistant" (nexo-strategic-assistant.json, path "nexo-assistant").
// Contrato do webhook:
//   POST { message, campaign_id, user_id } (json)
//   200  { request_id, intent, intent_label, question, answer, metadata }
//   400  { error:true, error_code, message }
//
// TODO: preencher a URL base do n8n quando o workflow estiver publicado.
// Ex.: 'https://SEU-DOMINIO-N8N/webhook/nexo-assistant'
(function () {
  var NEXO_ASSISTANT_WEBHOOK_URL = 'https://n8n.nexoproject.shop/webhook/nexo-assistant';

  async function postChatMessage(params) {
    var message = params.message;
    var campaignId = params.campaignId;
    var userId = params.userId;

    if (!NEXO_ASSISTANT_WEBHOOK_URL) {
      throw new Error(
        'Webhook do NEXO Strategic Assistant ainda não configurado. ' +
        'Defina NEXO_ASSISTANT_WEBHOOK_URL em frontend/services/chat.service.js.'
      );
    }
    var res = await fetch(NEXO_ASSISTANT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, campaign_id: campaignId, user_id: userId }),
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.error) {
      throw new Error(json.message || 'Falha ao consultar o NEXO.');
    }
    return json;
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.postChatMessage = postChatMessage;
})();
