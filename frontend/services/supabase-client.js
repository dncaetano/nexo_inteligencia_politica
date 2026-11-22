// Cliente Supabase compartilhado.
// Plain JS (sem bundler): expõe window.NexoServices.getClient().
// Carregado via <script src> antes do script do Component no .dc.html.
(function () {
  var cfg = window.NEXO_CONFIG || {};
  var client = null;

  function getClient() {
    if (client) return client;
    if (!window.supabase) return null;
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
      console.error('NEXO_CONFIG ausente: copie config.example.js para config.js.');
      return null;
    }
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
    return client;
  }

  // metadata/content de algumas tabelas (mentions.metadata, reports.content)
  // chegam double-encoded (jsonb contendo uma STRING JSON). Parse defensivo.
  function parseMaybeJSON(value, fallback) {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (e) { return fallback; }
  }

  window.NexoServices = window.NexoServices || {};
  window.NexoServices.getClient = getClient;
  window.NexoServices.parseMaybeJSON = parseMaybeJSON;
})();
