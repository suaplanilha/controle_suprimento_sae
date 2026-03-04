/**
 * API Gateway (Sprint 2)
 *
 * ORDEM DE CARREGAMENTO: Carregue após models.gs e services.gs
 * DEPENDE: funções globais de code.gs e namespace SAE (models.gs)
 * DECLARA: doPost, dispatchApiRequest_, parseApiPayload_, normalizeApiResponse_
 */

function doPost(e) {
  return ContentService
    .createTextOutput(JSON.stringify(executeSafely(() => dispatchApiRequest_(e), 'doPost')))
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatchApiRequest_(e) {
  const payload = parseApiPayload_(e);
  const action = String(payload.action || '').trim();
  const data = payload.data || {};

  const handlers = {
    login: () => doLogin(data),
    get_insumos: () => getInsumosData(data),
    get_dashboard: () => getDashboardData(data),
    update_stock: () => updateStockLevel(data),
    prepare_bulk: () => prepareBulkMovimentacao(data),
    save_bulk: () => saveBulkMovimentacao(data)
  };

  if (!handlers[action]) {
    throw new Error(`Ação de API inválida: ${action}`);
  }

  const result = handlers[action]();
  return normalizeApiResponse_(result, action);
}

function parseApiPayload_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function normalizeApiResponse_(result, action) {
  return {
    success: result && result.success !== false,
    action,
    timestamp: new Date().toISOString(),
    data: result
  };
}
