/**
 * SISTEMA APOLLO ENTERPRISE (SAE) - BACKEND APLICAÇÃO DE SUPRIMENTOS
 *
 * ORDEM DE CARREGAMENTO: Carregue após models.gs, core.gs, repositories.gs, services.gs, movimentacoes-service.gs, insumos-service.gs e fornecedores-service.gs
 * DEPENDE: SAE.* (de models.gs), core/repositories helpers, ValidationService, StockService, AuditLogger (de services.gs)
 * DECLARA: Funções públicas (doGet, doLogin, updateStockLevel, etc.)
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

function renderWebApp_(e) {
  const path = String((e && e.pathInfo) || '').trim().toLowerCase();
  saeLog_('DEBUG', 'renderWebApp_ iniciado', { path });

  // Fallback para evitar "Not Found" em prévias que chegam com path inesperado.
  const supportedPaths = ['', 'index', 'app', 'dev', 'exec'];
  if (!supportedPaths.includes(path)) {
    saeLog_('WARN', 'Path não mapeado, aplicando fallback para index', { path });
  }

  const output = HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('SAE - Gestão de Suprimentos')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  saeLog_('DEBUG', 'renderWebApp_ finalizado', { path });
  return output;
}

function doLogin(credentials) {
  return executeSafely(() => {
    // 1. Log inicial e normalização do e-mail
    saeLog_('INFO', 'doLogin recebido', {
      email: credentials && credentials.email ? String(credentials.email).trim().toLowerCase() : ''
    });

    // 2. Validação básica de entrada
    ValidationService.require(credentials, 'LOGIN');

    // 3. Acesso à tabela de usuários
    const usersSheet = getSheetOrThrow(SAE_TABLES.USUARIOS);
    const headers = getHeaders(usersSheet);
    const hasPasswordColumn = headers.includes('senha');

    const users = readTable(SAE_TABLES.USUARIOS);
    const user = users.find(row => String(row.email).toLowerCase() === String(credentials.email).toLowerCase());

    // 4. Verificação de existência do usuário
    if (!user) {
      saeLog_('WARN', 'doLogin usuário não encontrado', { email: credentials.email });
      throw new Error('Usuário não encontrado.');
    }

    // 5. Verificação de status (Bloqueia inativos)
    if (String(user.status).toUpperCase() !== 'ATIVO') {
      saeLog_('WARN', 'doLogin usuário inativo', { email: user.email, status: user.status });
      throw new Error('Usuário inativo. Contate o administrador.');
    }

    // 6. Verificação de Senha com Hash SHA-256
    if (hasPasswordColumn) {
      ValidationService.require(credentials, 'LOGIN_WITH_PASSWORD');

      // Transforma a senha digitada (texto puro) em Hash para comparação
      const inputPasswordRaw = String(credentials.password || '');
      const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, inputPasswordRaw);
      const inputPasswordHash = Utilities.base64Encode(digest);

      const expectedPasswordHash = String(user.senha || '');

      // Comparação de segurança: Hash vs Hash
      if (!expectedPasswordHash || expectedPasswordHash !== inputPasswordHash) {
        saeLog_('WARN', 'doLogin senha inválida', { email: user.email, hasPasswordColumn });
        throw new Error('Senha inválida.');
      }
    }

    // 7. Atualização de metadados e resposta de sucesso
    updateUserLastLogin(user.uuid);

    const allowedPages = parseAllowedPages(user.paginas_acesso);

    return {
      success: true,
      user: {
        uuid: user.uuid,
        nome: user.nome,
        email: user.email,
        role: user.permissao,
        pages: user.paginas_acesso,
        allowed_pages: allowedPages,
        landing_page: resolveLandingPage(allowedPages)
      }
    };
  }, 'doLogin');
}

function getInsumosData(filters) {
  return executeSafely(() => {
    saeLog_('DEBUG', 'getInsumosData chamado', { filters: sanitizeForLog_(filters) });
    return getInsumosDataCore(filters);
  }, 'getInsumosData');
}

function getDashboardData(filters) {
  return executeSafely(() => {
    saeLog_('DEBUG', 'getDashboardData chamado', { filters: sanitizeForLog_(filters) });
    const insumosResult = getInsumosDataCore(filters || {});
    saeLog_('DEBUG', 'getDashboardData resumo', {
      total: insumosResult && insumosResult.summary ? insumosResult.summary.total_insumos : 0,
      criticos: insumosResult && insumosResult.summary ? insumosResult.summary.criticos : 0
    });
    return {
      success: true,
      generated_at: new Date().toISOString(),
      ...insumosResult
    };
  }, 'getDashboardData');
}

function paginateRows(rows, page, pageSize) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * pageSize;
  return {
    success: true,
    data: rows.slice(start, start + pageSize),
    pagination: {
      page: current,
      pageSize,
      total,
      totalPages
    }
  };
}

function getExecutiveSummary(filters) {
  return executeSafely(() => {
    const result = getInsumosDataCore(filters || {});
    const data = result.data;

    const criticos = data.filter(item => item.status_estoque === 'CRITICO');
    const emRisco = criticos.reduce((acc, item) => acc + Number(item.saldo_atual || 0), 0);
    const leadTimeRisco = data.filter(item => Number(item.lead_time || 0) > Number(item.dias_estimados_consumo || 0));

    const estoqueAtual = data.reduce((acc, item) => acc + Number(item.saldo_atual || 0), 0);
    const demandaMensal = data.reduce((acc, item) => acc + Number(item.consumo_medio_mensal || 0), 0);
    const coberturaGlobalMeses = demandaMensal > 0 ? Number((estoqueAtual / demandaMensal).toFixed(2)) : null;

    return {
      success: true,
      generated_at: new Date().toISOString(),
      total_itens: data.length,
      itens_criticos: criticos.length,
      volume_em_risco: emRisco,
      itens_lead_time_maior_que_autonomia: leadTimeRisco.map(item => ({
        codigo_ax: item.codigo_ax,
        descricao: item.descricao,
        lead_time: item.lead_time,
        autonomia_dias: item.dias_estimados_consumo
      })),
      cobertura_estoque_global_meses: coberturaGlobalMeses
    };
  });
}

function runWeeklyBackupSnapshot() {
  return executeSafely(() => {
    const configs = readConfigMap({ forceRefresh: true });
    const backupSpreadsheetId = String(configs.backup_spreadsheet_id || '').trim();

    if (!backupSpreadsheetId) {
      throw new Error('Parâmetro backup_spreadsheet_id não configurado em config_parametros.');
    }

    const source = SpreadsheetApp.getActiveSpreadsheet();
    const target = SpreadsheetApp.openById(backupSpreadsheetId);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    ['cad_insumos', 'mov_estoque'].forEach(name => {
      const src = source.getSheetByName(name);
      if (!src) return;

      const copy = src.copyTo(target);
      copy.setName(`snapshot_${name}_${stamp}`);
    });

    return {
      success: true,
      message: 'Snapshot semanal realizado com sucesso.',
      snapshot_id: stamp,
      backup_spreadsheet_id: backupSpreadsheetId
    };
  });
}

function test_runAllCalculations() {
  return executeSafely(() => {
    const mockInsumo = {
      uuid: 'I1',
      codigo_ax: '1001',
      descricao: 'Item Teste',
      lead_time: 10,
      estoque_minimo: 30,
      consenso_dias: 45,
      categoria: 'C'
    };

    const now = new Date();
    const mockMovs = [
      { insumo_id: 'I1', tipo: 'ENTRADA', quantidade: 300, data_iso: new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString() },
      { insumo_id: 'I1', tipo: 'SAIDA', quantidade: 120, data_iso: new Date(now.getFullYear(), now.getMonth() - 1, 5).toISOString() },
      { insumo_id: 'I1', tipo: 'SAIDA', quantidade: 80, data_iso: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() }
    ];

    const cfg = { diasUteis: 25, janelaMeses: 12, tratarMesSemMovimentoComoZero: true };
    const enriched = enrichInsumo(mockInsumo, mockMovs, cfg);
    const order = calculateOrderPoint(enriched);

    const expectedMonthly = Number(((120 + 80) / 12).toFixed(2));
    const expectedPR = Math.ceil((10 * (expectedMonthly / 25)) + 30);

    if (Number(enriched.consumo_medio_mensal) !== expectedMonthly) {
      throw new Error(`Teste consumo_medio_mensal falhou: esperado ${expectedMonthly}, obtido ${enriched.consumo_medio_mensal}`);
    }

    if (Number(enriched.ponto_ressuprimento) !== expectedPR) {
      throw new Error(`Teste ponto_ressuprimento falhou: esperado ${expectedPR}, obtido ${enriched.ponto_ressuprimento}`);
    }

    if (!Number.isFinite(order.sugestao_compra)) {
      throw new Error('Teste motor de ressuprimento falhou: sugestao_compra inválida.');
    }

    return {
      success: true,
      message: 'test_runAllCalculations executado com sucesso.',
      enriched,
      order
    };
  });
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getInsumosDataCore(filters) {
  const safeFilters = filters || {};
  const insumos = readTable(SAE_TABLES.INSUMOS).filter(row => String(row.ativo || 'ATIVO').toUpperCase() !== 'INATIVO');
  const movimentos = readTable(SAE_TABLES.MOVIMENTACOES).map(sanitizeMovementRow);
  const configs = readConfigMap();

  const diasUteis = sanitizeNumber(configs.dias_uteis_mes || 25);
  const janelaMeses = sanitizeNumber(configs.janela_media_meses || 12);
  const tratarMesSemMovimentoComoZero = String(configs.tratar_mes_sem_movimento || 'ZERO').toUpperCase() !== 'IGNORAR';

  const abcMap = computeAbcCategoryMap(insumos, movimentos, janelaMeses);
  syncAbcCategories(insumos, abcMap);

  const data = insumos
    .map(insumo => {
      const enriched = enrichInsumo(insumo, movimentos, { diasUteis, janelaMeses, tratarMesSemMovimentoComoZero });
      return {
        ...enriched,
        categoria: abcMap[insumo.uuid] || enriched.categoria || 'C'
      };
    })
    .filter(insumo => applyInsumoFilters(insumo, safeFilters))
    .sort((a, b) => String(a.codigo_ax).localeCompare(String(b.codigo_ax)));

  return {
    success: true,
    data,
    summary: {
      total: data.length,
      criticos: data.filter(item => item.status_estoque === 'CRITICO').length,
      em_alerta: data.filter(item => item.status_estoque === 'ALERTA').length,
      saudaveis: data.filter(item => item.status_estoque === 'OK').length
    }
  };
}

function enrichInsumo(insumo, movimentos, config) {
  const movs = movimentos.filter(m => m.insumo_id === insumo.uuid);

  const saldo = movs.reduce((acc, mov) => {
    const q = sanitizeNumber(mov.quantidade);
    if (mov.tipo === 'SAIDA') return acc - q;
    return acc + q;
  }, 0);

  const consumoMensal = calculateMonthlyConsumption(movs, config.janelaMeses, config.tratarMesSemMovimentoComoZero);
  const consumoDiario = config.diasUteis > 0 ? consumoMensal / config.diasUteis : 0;

  const withMetrics = {
    ...insumo,
    codigo_ax: sanitizeCodigoAX(insumo.codigo_ax),
    saldo_atual: Number(saldo.toFixed(2)),
    consumo_medio_mensal: Number(consumoMensal.toFixed(2)),
    consumo_medio_diario: Number(consumoDiario.toFixed(4))
  };

  const orderPoint = calculateOrderPoint(withMetrics);

  return {
    ...withMetrics,
    ponto_ressuprimento: orderPoint.ponto_ressuprimento,
    sugestao_compra: orderPoint.sugestao_compra,
    data_estimada_ruptura: orderPoint.data_estimada_ruptura,
    dias_estimados_consumo: orderPoint.dias_estimados_consumo,
    giro_estoque: consumoMensal > 0 ? Number((saldo / consumoMensal).toFixed(2)) : 0,
    status_estoque: computeStatus(saldo, orderPoint.ponto_ressuprimento)
  };
}

function calculateOrderPoint(insumo) {
  const leadTime = sanitizeNumber(insumo.lead_time);
  const estoqueMinimo = sanitizeNumber(insumo.estoque_minimo);
  const consensoDias = sanitizeNumber(insumo.consenso_dias || 30);
  const consumoDiario = sanitizeNumber(insumo.consumo_medio_diario);
  const saldo = sanitizeNumber(insumo.saldo_atual);

  const pontoRessuprimento = Math.ceil((leadTime * consumoDiario) + estoqueMinimo);
  const estoqueAlvo = Math.ceil(consensoDias * consumoDiario);
  const sugestaoCompra = Math.max(0, Math.ceil(estoqueAlvo - saldo));

  let diasEstimados = null;
  let dataRuptura = null;

  if (consumoDiario > 0) {
    diasEstimados = Number((saldo / consumoDiario).toFixed(1));
    const ruptura = new Date();
    ruptura.setDate(ruptura.getDate() + Math.max(0, Math.floor(diasEstimados)));
    dataRuptura = ruptura.toISOString();
  }

  return {
    ponto_ressuprimento: pontoRessuprimento,
    sugestao_compra: sugestaoCompra,
    dias_estimados_consumo: diasEstimados,
    data_estimada_ruptura: dataRuptura
  };
}

function calculateMonthlyConsumption(movs, janelaMeses, treatMissingAsZero) {
  const months = Math.max(1, sanitizeNumber(janelaMeses));
  const monthTotals = {};

  for (let i = 0; i < months; i += 1) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthTotals[key] = 0;
  }

  movs.forEach(mov => {
    if (mov.tipo !== 'SAIDA') return;
    const dt = new Date(mov.data_iso);
    if (Number.isNaN(dt.getTime())) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (Object.prototype.hasOwnProperty.call(monthTotals, key)) {
      monthTotals[key] += sanitizeNumber(mov.quantidade);
    }
  });

  const values = Object.values(monthTotals);
  if (!values.length) return 0;

  if (treatMissingAsZero) {
    return values.reduce((acc, val) => acc + val, 0) / values.length;
  }

  const nonZero = values.filter(val => val > 0);
  if (!nonZero.length) return 0;
  return nonZero.reduce((acc, val) => acc + val, 0) / nonZero.length;
}

function computeAbcCategoryMap(insumos, movimentos, janelaMeses) {
  const months = Math.max(1, sanitizeNumber(janelaMeses));
  const limit = new Date();
  limit.setMonth(limit.getMonth() - months);

  const volumeByInsumo = {};
  insumos.forEach(i => {
    volumeByInsumo[i.uuid] = 0;
  });

  movimentos.forEach(mov => {
    if (mov.tipo !== 'SAIDA') return;
    const dt = new Date(mov.data_iso);
    if (Number.isNaN(dt.getTime()) || dt < limit) return;

    if (Object.prototype.hasOwnProperty.call(volumeByInsumo, mov.insumo_id)) {
      volumeByInsumo[mov.insumo_id] += sanitizeNumber(mov.quantidade);
    }
  });

  const ranking = Object.keys(volumeByInsumo)
    .map(id => ({ id, volume: volumeByInsumo[id] }))
    .sort((a, b) => b.volume - a.volume);

  const total = ranking.reduce((acc, item) => acc + item.volume, 0);
  if (total <= 0) {
    return ranking.reduce((acc, item) => {
      acc[item.id] = 'C';
      return acc;
    }, {});
  }

  let acumulado = 0;
  return ranking.reduce((acc, item) => {
    acumulado += item.volume;
    const percentual = (acumulado / total) * 100;
    if (percentual <= 80) {
      acc[item.id] = 'A';
    } else if (percentual <= 95) {
      acc[item.id] = 'B';
    } else {
      acc[item.id] = 'C';
    }
    return acc;
  }, {});
}

function syncAbcCategories(insumos, abcMap) {
  const sheet = getSheetOrThrow(SAE_TABLES.INSUMOS);
  const headers = getHeaders(sheet);
  const idxCategoria = headers.indexOf('categoria');
  const idxUuid = headers.indexOf('uuid');

  if (idxCategoria === -1 || idxUuid === -1) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i += 1) {
    const uuid = data[i][idxUuid];
    const newCategory = abcMap[uuid];
    if (!newCategory) continue;
    if (String(data[i][idxCategoria] || '') !== newCategory) {
      sheet.getRange(i + 1, idxCategoria + 1).setValue(newCategory);
    }
  }
}

function computeStatus(saldo, ponto) {
  if (saldo <= ponto * SAE.ESTOQUE_STATUS.CRITICO.threshold) return 'CRITICO';
  if (saldo <= ponto * SAE.ESTOQUE_STATUS.ALERTA.threshold) return 'ALERTA';
  return 'OK';
}

function applyInsumoFilters(insumo, filters) {
  if (filters.insumo_id && insumo.uuid !== filters.insumo_id) return false;

  if (filters.query) {
    const q = String(filters.query).toLowerCase().trim();
    const haystack = `${insumo.codigo_ax} ${insumo.descricao}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  if (filters.status && insumo.status_estoque !== filters.status) return false;

  return true;
}

function checkUserPermission(email, page) {
  validateRequired({ email, page }, ['email', 'page']);
  const users = readTable(SAE_TABLES.USUARIOS);
  const user = users.find(row => String(row.email).toLowerCase() === String(email).toLowerCase());

  if (!user) {
    throw new Error('Usuário não encontrado para validação de permissão.');
  }

  if (String(user.status).toUpperCase() !== 'ATIVO') {
    throw new Error('Usuário inativo sem permissão para executar esta ação.');
  }

  const allowed = parseAllowedPages(user.paginas_acesso);
  if (!allowed.includes(String(page).toLowerCase())) {
    throw new Error(`Usuário sem permissão para acessar: ${page}`);
  }

  return true;
}

function readConfigMap(options) {
  const forceRefresh = !!(options && options.forceRefresh);
  const cache = new CacheManager();

  if (!forceRefresh) {
    const ts = cache.getNumber(SAE_CACHE.CONFIG_TS_KEY);
    const payload = cache.getJson(SAE_CACHE.CONFIG_KEY);
    if (payload && (Date.now() - ts) < SAE_CACHE.CONFIG_TTL_MS) {
      return payload;
    }
  }

  const rows = readTable(SAE_TABLES.CONFIG);
  const map = rows.reduce((acc, row) => {
    acc[String(row.parametro)] = row.valor;
    return acc;
  }, {});

  cache.setJson(SAE_CACHE.CONFIG_KEY, map);
  cache.setNumber(SAE_CACHE.CONFIG_TS_KEY, Date.now());

  return map;
}


function findByCodigoAX(sheetName, codigoAX) {
  const normalized = sanitizeCodigoAX(codigoAX);
  return readTable(sheetName).find(row => sanitizeCodigoAX(row.codigo_ax) === normalized);
}

function updateUserLastLogin(userId) {
  const sheet = getSheetOrThrow(SAE_TABLES.USUARIOS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idxUuid = headers.indexOf('uuid');
  const idxLastLogin = headers.indexOf('ultimo_login');

  for (let i = 1; i < data.length; i += 1) {
    if (data[i][idxUuid] === userId) {
      sheet.getRange(i + 1, idxLastLogin + 1).setValue(new Date().toISOString());
      return;
    }
  }
}

function sae_setupDatabase() {
  return executeSafely(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const ensureSheet = (name, headers) => {
      let sheet = ss.getSheetByName(name);
      if (!sheet) {
        sheet = ss.insertSheet(name);
      }
      const hasHeader = sheet.getLastRow() >= 1;
      if (!hasHeader) {
        sheet.appendRow(headers);
        sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      }
      return sheet;
    };

    ensureSheet(SAE_TABLES.INSUMOS, ['uuid', 'codigo_ax', 'descricao', 'unidade', 'fornecedor_id', 'lead_time', 'estoque_minimo', 'consenso_dias', 'categoria', 'ativo', 'criado_em']);
    ensureSheet(SAE_TABLES.MOVIMENTACOES, ['uuid', 'data_iso', 'insumo_id', 'codigo_ax', 'tipo', 'quantidade', 'usuario_email', 'observacao']);
    ensureSheet(SAE_TABLES.FORNECEDORES, ['uuid', 'nome_fantasia', 'razao_social', 'cnpj', 'contato', 'telefone', 'email', 'ativo', 'criado_em']);
    ensureSheet(SAE_TABLES.USUARIOS, ['uuid', 'nome', 'email', 'senha', 'permissao', 'paginas_acesso', 'status', 'ultimo_login']);
    ensureSheet(SAE_TABLES.CONFIG, ['parametro', 'valor', 'descricao']);
    ensureSheet(SAE_TABLES.UPLOAD_HISTORY, ['uuid', 'upload_id', 'data_iso', 'tipo', 'arquivo_nome', 'usuario_email', 'total_linhas', 'total_validas', 'total_invalidas', 'detalhes_json', 'criado_em']);

    if (!ss.getSheetByName(SAE_TABLES.IDEMPOTENCY)) {
      const sheetIdempotencia = ss.insertSheet(SAE_TABLES.IDEMPOTENCY);
      sheetIdempotencia.appendRow([
        'uuid',
        'request_id',
        'endpoint',
        'status',
        'resultado_json',
        'payload_hash',
        'usuario_email',
        'timestamp_processado',
        'observacao'
      ]);
      sheetIdempotencia.getRange(1, 1, 1, 9).setFontWeight('bold');
      saeLog_('INFO', 'sae_setupDatabase: Aba log_requisicoes_idempotencia criada', {});
    }

    return {
      success: true,
      message: 'Database setup completo.'
    };
  }, 'sae_setupDatabase');
}


function validateRequired(payload, requiredFields) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload inválido.');
  }
  requiredFields.forEach(field => {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      throw new Error(`Campo obrigatório não informado: ${field}`);
    }
  });
}


function parseAllowedPages(rawPages) {
  const raw = String(rawPages || '').trim();
  if (!raw || raw.toUpperCase() === 'ALL') {
    return ['dashboard', 'insumos', 'fornecedores', 'movimentacoes', 'compras', 'configuracoes'];
  }

  return raw
    .split(',')
    .map(page => page.trim().toLowerCase())
    .filter(Boolean);
}

function resolveLandingPage(allowedPages) {
  if (!allowedPages || !allowedPages.length) return 'dashboard';
  return allowedPages[0];
}
