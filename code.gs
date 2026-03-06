/**
 * SISTEMA APOLLO ENTERPRISE (SAE) - BACKEND APLICAÇÃO DE SUPRIMENTOS
 *
 * ORDEM DE CARREGAMENTO: Carregue após models.gs, core.gs, repositories.gs, services.gs, movimentacoes-service.gs, insumos-service.gs, fornecedores-service.gs, analytics-service.gs, setup-admin.gs e facade-support.gs
 * DEPENDE: SAE.* (de models.gs), helpers/serviços modulares extraídos e funções globais públicas
 * DECLARA: constantes globais e entradas públicas (fachada)
 */

const SAE_TABLES = {
  INSUMOS: 'cad_insumos',
  MOVIMENTACOES: 'mov_estoque',
  FORNECEDORES: 'cad_fornecedores',
  USUARIOS: 'sys_usuarios',
  CONFIG: 'config_parametros',
  UPLOAD_HISTORY: 'log_upload_mov',
  IDEMPOTENCY: 'log_requisicoes_idempotencia'
};

const SAE_CACHE = {
  CONFIG_KEY: `sae_config_cache_${SAE.CACHE_VERSION}`,
  CONFIG_TS_KEY: `sae_config_cache_ts_${SAE.CACHE_VERSION}`,
  CONFIG_TTL_MS: 5 * 60 * 1000
};

const SAE_LOG_PREFIX = '[SAE]';

function doGet(e) {
  const reqMeta = {
    pathInfo: (e && e.pathInfo) || '',
    parameterKeys: e && e.parameter ? Object.keys(e.parameter) : [],
    queryString: (e && e.queryString) || ''
  };
  saeLog_('INFO', 'doGet iniciado', reqMeta);
  try {
    const html = renderWebApp_(e);
    saeLog_('INFO', 'doGet finalizado com sucesso', reqMeta);
    return html;
  } catch (error) {
    saeLog_('ERROR', 'Falha em doGet', {
      reqMeta,
      error: (error && error.message) ? error.message : String(error)
    });
    return HtmlService.createHtmlOutput(`<!doctype html><html><body style="font-family:Arial;padding:16px"><h3>Falha ao renderizar preview</h3><pre>${error && error.message ? error.message : String(error)}</pre></body></html>`)
      .setTitle('SAE - Erro de Preview');
  }
}

function doLogin(credentials) {
  return doLoginService_(credentials);
}

function getInsumosData(filters) {
  return getInsumosDataService_(filters);
}

function getDashboardData(filters) {
  return getDashboardDataService_(filters);
}
