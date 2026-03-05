/**
 * API Gateway (Sprint 2)
 *
 * ORDEM DE CARREGAMENTO: Carregue após models.gs, core.gs, repositories.gs, services.gs e módulos de domínio
 * DEPENDE: funções globais expostas pela fachada + serviços/modulos
 * DECLARA: doPost, dispatchApiRequest_, parseApiPayload_, normalizeApiResponse_
 */

function doPost(e) {
  return ContentService
    .createTextOutput(JSON.stringify(executeSafely(() => dispatchApiRequest_(e), 'doPost')))
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatchApiRequest_(e) {
  const payload = parseApiPayload_(e);
  const action = String(payload.action || '').trim().toLowerCase();
  const data = payload.data || {};

  if (!action) {
    throw new Error('Ação de API não informada.');
  }

  const handlers = {
    // Auth / dashboard
    login: () => doLogin(data),
    get_dashboard: () => getDashboardData(data),

    // Insumos (analytics + CRUD)
    get_insumos: () => getInsumosData(data),
    list_insumos: () => listInsumos(data),
    save_insumo: () => saveInsumo(data),
    inactivate_insumo: () => inactivateInsumo(data),

    // Fornecedores
    get_fornecedor_options: () => getFornecedorOptions(),
    list_fornecedores: () => listFornecedores(data),
    save_fornecedor: () => saveFornecedor(data),
    inactivate_fornecedor: () => inactivateFornecedor(data),

    // Movimentações
    get_movimentacoes: () => listMovimentacoes(data),
    update_stock: () => updateStockLevel(data),
    prepare_bulk: () => prepareBulkMovimentacao(data),
    save_bulk: () => saveBulkMovimentacao(data),
    delete_movimentacao: () => deleteMovimentacao(data),
    get_upload_history: () => getUploadHistory(data && data.limit)
  };

  if (!handlers[action]) {
    throw new Error(`Ação de API inválida: ${action}`);
  }

  const result = handlers[action]();
  return normalizeApiResponse_(result, action);
}

function parseApiPayload_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throw new Error(`Payload JSON inválido: ${error.message || String(error)}`);
  }
}

function normalizeApiResponse_(result, action) {
  return {
    success: result && result.success !== false,
    action,
    timestamp: new Date().toISOString(),
    data: result
  };
}
