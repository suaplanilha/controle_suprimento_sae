/**
 * SISTEMA APOLLO ENTERPRISE (SAE) - BACKEND APLICAÇÃO DE SUPRIMENTOS
 *
 * ORDEM DE CARREGAMENTO: Carregue após models.gs e services.gs
 * DEPENDE: SAE.* (de models.gs), ValidationService, StockService, AuditLogger (de services.gs)
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

function updateStockLevel(payload) {
  return executeSafely(() => {
    ValidationService.require(payload, 'MOVIMENTACAO');
    checkUserPermission(payload.usuario_email, 'movimentacoes');

    const hasInsumoId = String(payload.insumo_id || '').trim().length > 0;
    const hasCodigoAX = String(payload.codigo_ax || '').trim().length > 0;
    if (!hasInsumoId && !hasCodigoAX) {
      throw new Error('Informe código AX ou insumo_id para registrar a movimentação.');
    }

    const tipo = String(payload.tipo).toUpperCase();
    if (!['ENTRADA', 'SAIDA', 'AJUSTE'].includes(tipo)) {
      throw new Error('Tipo de movimentação inválido. Use ENTRADA, SAIDA ou AJUSTE.');
    }

    const quantidade = sanitizeNumber(payload.quantidade, 'quantidade');
    if (quantidade <= 0) {
      throw new Error('Quantidade inválida. Informe um número maior que zero.');
    }

    const insumo = resolveInsumoForMovimentacao_(payload);
    if (!insumo) {
      throw new Error('Insumo não encontrado para o identificador informado (codigo_ax/insumo_id).');
    }

    const saldoAnterior = getCurrentStockByInsumo(insumo.uuid);
    const saldoPosterior = StockService.applyMutation(saldoAnterior, tipo, quantidade);

    const obsBase = String(payload.observacao || '').trim();
    const obsAudit = `[AUDIT] saldo_anterior=${saldoAnterior}; saldo_posterior=${saldoPosterior}`;

    const movimento = {
      uuid: generateUUID(),
      data_iso: toIsoString(payload.data_iso),
      insumo_id: insumo.uuid,
      codigo_ax: sanitizeCodigoAX(insumo.codigo_ax),
      tipo,
      quantidade,
      usuario_email: String(payload.usuario_email).trim(),
      observacao: obsBase ? `${obsBase} | ${obsAudit}` : obsAudit
    };

    insertRow(SAE_TABLES.MOVIMENTACOES, movimento);
    AuditLogger.logMovimentacao({
      insumo_id: insumo.uuid,
      codigo_ax: insumo.codigo_ax,
      tipo,
      quantidade,
      usuario_email: payload.usuario_email,
      saldo_anterior: saldoAnterior,
      saldo_posterior: saldoPosterior,
      origem: 'updateStockLevel'
    });

    const enriched = getInsumosDataCore({ insumo_id: insumo.uuid }).data[0];

    return {
      success: true,
      message: 'Movimentação registrada com sucesso.',
      movimentacao: movimento,
      insumo: enriched
    };
  });
}


function prepareBulkMovimentacao(payload) {
  return executeSafely(() => {
    ValidationService.require(payload, 'BULK_MOVIMENTACAO');
    checkUserPermission(payload.usuario_email, 'movimentacoes');

    if (!Array.isArray(payload.rows) || !payload.rows.length) {
      throw new Error('Nenhuma linha enviada para processamento.');
    }

    const dataIso = toIsoString(payload.data_iso);
    const tipo = String(payload.tipo || 'SAIDA').toUpperCase();
    if (!['ENTRADA', 'SAIDA', 'AJUSTE'].includes(tipo)) {
      throw new Error('Tipo inválido para lote.');
    }

    const insumos = readTable(SAE_TABLES.INSUMOS);
    const byCodigo = {};
    insumos.forEach(item => {
      byCodigo[sanitizeCodigoAX(item.codigo_ax)] = item;
    });

    const preview = payload.rows.map((raw, idx) => {
      const codigoAX = sanitizeCodigoAX(raw.codigo_ax);
      const q = sanitizeNumber(raw.quantidade);
      const insumo = byCodigo[codigoAX];

      return {
        row_number: idx + 1,
        codigo_ax: codigoAX,
        descricao: insumo ? String(insumo.descricao || '') : 'INSUMO NÃO ENCONTRADO',
        insumo_id: insumo ? insumo.uuid : '',
        quantidade: q,
        valid: !!insumo && q > 0,
        error: !insumo ? 'Código AX não encontrado.' : (q <= 0 ? 'Quantidade deve ser maior que zero.' : ''),
        locked_identity: true
      };
    });

    return {
      success: true,
      data_iso: dataIso,
      tipo,
      total_rows: preview.length,
      total_valid: preview.filter(r => r.valid).length,
      total_invalid: preview.filter(r => !r.valid).length,
      rows: preview
    };
  });
}

function saveBulkMovimentacao(payload) {
  return executeSafely(() => {
    ValidationService.require(payload, 'BULK_MOVIMENTACAO');
    checkUserPermission(payload.usuario_email, 'movimentacoes');

    // ===== VERIFICAÇÃO DE IDEMPOTÊNCIA =====
    const requestId = String(payload.request_id || '').trim();
    if (!requestId) {
      throw new Error('request_id obrigatório para garantir idempotência. Frontend deve gerar UUID.');
    }

    const cached = IdempotencyService.checkIfProcessed(requestId);
    if (cached) {
      saeLog_('WARN', 'saveBulkMovimentacao: Requisição duplicada detectada', {
        requestId,
        usuarioEmail: payload.usuario_email
      });
      return cached;
    }

    const payloadHash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(payload.rows || [])));
    IdempotencyService.markAsProcessing(requestId, 'saveBulkMovimentacao', payload.usuario_email, payloadHash);
    // ===== FIM VERIFICAÇÃO DE IDEMPOTÊNCIA =====

    try {
      const tipo = String(payload.tipo || 'SAIDA').toUpperCase();
      if (!['ENTRADA', 'SAIDA', 'AJUSTE'].includes(tipo)) {
        throw new Error('Tipo inválido para lote.');
      }

      const dataIso = toIsoString(payload.data_iso);
      const uploadId = generateUUID();

      const validRows = (payload.rows || []).filter(row => row.valid && row.insumo_id && sanitizeNumber(row.quantidade) > 0);
      if (!validRows.length) {
        throw new Error('Nenhuma linha válida para salvar.');
      }

      const movimentos = validRows.map(row => {
        const insumo = findById(SAE_TABLES.INSUMOS, row.insumo_id);
        if (!insumo) {
          return null;
        }

        const saldoAnterior = getCurrentStockByInsumo(insumo.uuid);
        const quantidade = sanitizeNumber(row.quantidade, 'quantidade');
        const saldoPosterior = StockService.applyMutation(saldoAnterior, tipo, quantidade);
        const obsAudit = `[BULK:${uploadId}] saldo_anterior=${saldoAnterior}; saldo_posterior=${saldoPosterior}`;

        return {
          uuid: generateUUID(),
          data_iso: dataIso,
          insumo_id: insumo.uuid,
          codigo_ax: sanitizeCodigoAX(insumo.codigo_ax),
          tipo,
          quantidade,
          usuario_email: String(payload.usuario_email).trim(),
          observacao: payload.observacao ? `${payload.observacao} | ${obsAudit}` : obsAudit
        };
      }).filter(Boolean);

      batchInsertRows(SAE_TABLES.MOVIMENTACOES, movimentos);

      insertRow(SAE_TABLES.UPLOAD_HISTORY, {
        uuid: generateUUID(),
        upload_id: uploadId,
        data_iso: dataIso,
        tipo,
        arquivo_nome: String(payload.file_name || ''),
        usuario_email: String(payload.usuario_email).trim(),
        total_linhas: payload.rows.length,
        total_validas: movimentos.length,
        total_invalidas: payload.rows.length - movimentos.length,
        detalhes_json: JSON.stringify({
          request_id: requestId,
          sample: payload.rows.slice(0, 10),
          observacao: payload.observacao || ''
        }),
        criado_em: new Date().toISOString()
      });

      const resultado = {
        success: true,
        message: 'Upload em massa salvo com sucesso.',
        upload_id: uploadId,
        total_movimentos: movimentos.length,
        request_id: requestId
      };

      const markSuccess = IdempotencyService.markAsSuccess(requestId, 'saveBulkMovimentacao', resultado, payload.usuario_email);

      if (!markSuccess) {
        saeLog_('ERROR', 'saveBulkMovimentacao: Falha ao marcar como SUCESSO', {
          requestId,
          uploadId,
          totalMovimentos: movimentos.length
        });
      }

      return resultado;
    } catch (innerError) {
      IdempotencyService.markAsFailure(requestId, 'saveBulkMovimentacao', innerError.message, payload.usuario_email);
      throw innerError;
    }
  }, 'saveBulkMovimentacao');
}

function getUploadHistory(limit) {
  return executeSafely(() => {
    const rows = readTable(SAE_TABLES.UPLOAD_HISTORY);
    const max = Math.max(1, sanitizeNumber(limit || 20));
    const ordered = rows.sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')));
    return {
      success: true,
      data: ordered.slice(0, max)
    };
  });
}


function listInsumos(payload) {
  return executeSafely(() => {
    const safe = payload || {};
    const page = Math.max(1, sanitizeNumber(safe.page || 1));
    const pageSize = Math.max(1, sanitizeNumber(safe.pageSize || 20));
    const query = String(safe.query || '').toLowerCase().trim();

    const fornecedores = readTable(SAE_TABLES.FORNECEDORES);
    const fornecedorMap = fornecedores.reduce((acc, row) => {
      acc[String(row.uuid)] = row;
      return acc;
    }, {});

    let rows = readTable(SAE_TABLES.INSUMOS).map(row => ({
      ...row,
      codigo_ax: sanitizeCodigoAX(row.codigo_ax),
      ativo: String(row.ativo || 'ATIVO').toUpperCase(),
      fornecedor_nome: fornecedorMap[String(row.fornecedor_id || '')]?.nome_fantasia || ''
    }));

    if (query) {
      rows = rows.filter(row => {
        const text = `${row.codigo_ax} ${row.descricao} ${row.fornecedor_nome}`.toLowerCase();
        return text.includes(query);
      });
    }

    if (safe.status) {
      rows = rows.filter(r => String(r.ativo) === String(safe.status).toUpperCase());
    }

    rows.sort((a, b) => String(a.codigo_ax).localeCompare(String(b.codigo_ax)));
    return paginateRows(rows, page, pageSize);
  });
}

function saveInsumo(payload) {
  return executeSafely(() => {
    validateRequired(payload, ['codigo_ax', 'descricao', 'unidade', 'lead_time', 'estoque_minimo', 'consenso_dias', 'categoria']);
    if (payload.usuario_email) checkUserPermission(payload.usuario_email, 'insumos');

    const sheet = getSheetOrThrow(SAE_TABLES.INSUMOS);
    const headers = getHeaders(sheet);

    const entity = {
      codigo_ax: sanitizeCodigoAX(payload.codigo_ax),
      descricao: String(payload.descricao || '').trim(),
      unidade: String(payload.unidade || '').trim(),
      fornecedor_id: String(payload.fornecedor_id || '').trim(),
      lead_time: sanitizeNumber(payload.lead_time, 'lead_time'),
      estoque_minimo: sanitizeNumber(payload.estoque_minimo, 'estoque_minimo'),
      consenso_dias: sanitizeNumber(payload.consenso_dias, 'consenso_dias'),
      categoria: String(payload.categoria || 'C').toUpperCase(),
      ativo: String(payload.ativo || 'ATIVO').toUpperCase()
    };

    const existingByCodigo = readTable(SAE_TABLES.INSUMOS)
      .find(r => sanitizeCodigoAX(r.codigo_ax) === entity.codigo_ax && String(r.uuid) !== String(payload.uuid || ''));
    if (existingByCodigo) {
      throw new Error('Já existe insumo com este código AX.');
    }

    if (payload.uuid) {
      const rowIndex = findRowIndexByUuid(sheet, payload.uuid);
      if (rowIndex < 2) throw new Error('Insumo não encontrado para edição.');
      updateRowByHeaderMap(sheet, headers, rowIndex, entity);
      return { success: true, message: 'Insumo atualizado com sucesso.' };
    }

    insertRow(SAE_TABLES.INSUMOS, {
      uuid: generateUUID(),
      ...entity,
      criado_em: new Date().toISOString()
    });
    return { success: true, message: 'Insumo cadastrado com sucesso.' };
  });
}

function inactivateInsumo(payload) {
  return executeSafely(() => {
    validateRequired(payload, ['uuid']);
    if (payload.usuario_email) checkUserPermission(payload.usuario_email, 'insumos');

    const sheet = getSheetOrThrow(SAE_TABLES.INSUMOS);
    const headers = getHeaders(sheet);
    const rowIndex = findRowIndexByUuid(sheet, payload.uuid);
    if (rowIndex < 2) throw new Error('Insumo não encontrado.');

    updateRowByHeaderMap(sheet, headers, rowIndex, { ativo: 'INATIVO' });
    return { success: true, message: 'Insumo inativado com sucesso.' };
  });
}

function listFornecedores(payload) {
  return executeSafely(() => {
    const safe = payload || {};
    const page = Math.max(1, sanitizeNumber(safe.page || 1));
    const pageSize = Math.max(1, sanitizeNumber(safe.pageSize || 20));
    const query = String(safe.query || '').toLowerCase().trim();

    let rows = readTable(SAE_TABLES.FORNECEDORES).map(row => ({
      ...row,
      ativo: String(row.ativo || 'ATIVO').toUpperCase()
    }));

    if (query) {
      rows = rows.filter(row => `${row.nome_fantasia} ${row.uuid}`.toLowerCase().includes(query));
    }

    if (safe.status) {
      rows = rows.filter(r => String(r.ativo) === String(safe.status).toUpperCase());
    }

    rows.sort((a, b) => String(a.nome_fantasia || '').localeCompare(String(b.nome_fantasia || '')));
    return paginateRows(rows, page, pageSize);
  });
}

function saveFornecedor(payload) {
  return executeSafely(() => {
    validateRequired(payload, ['nome_fantasia', 'razao_social']);
    if (payload.usuario_email) checkUserPermission(payload.usuario_email, 'fornecedores');

    const sheet = getSheetOrThrow(SAE_TABLES.FORNECEDORES);
    const headers = getHeaders(sheet);

    const entity = {
      nome_fantasia: String(payload.nome_fantasia || '').trim(),
      razao_social: String(payload.razao_social || '').trim(),
      cnpj: String(payload.cnpj || '').trim(),
      contato: String(payload.contato || '').trim(),
      telefone: String(payload.telefone || '').trim(),
      email: String(payload.email || '').trim(),
      ativo: String(payload.ativo || 'ATIVO').toUpperCase()
    };

    if (payload.uuid) {
      const rowIndex = findRowIndexByUuid(sheet, payload.uuid);
      if (rowIndex < 2) throw new Error('Fornecedor não encontrado para edição.');
      updateRowByHeaderMap(sheet, headers, rowIndex, entity);
      return { success: true, message: 'Fornecedor atualizado com sucesso.' };
    }

    insertRow(SAE_TABLES.FORNECEDORES, {
      uuid: generateUUID(),
      ...entity
    });
    return { success: true, message: 'Fornecedor cadastrado com sucesso.' };
  });
}

function inactivateFornecedor(payload) {
  return executeSafely(() => {
    validateRequired(payload, ['uuid']);
    if (payload.usuario_email) checkUserPermission(payload.usuario_email, 'fornecedores');

    const sheet = getSheetOrThrow(SAE_TABLES.FORNECEDORES);
    const headers = getHeaders(sheet);
    const rowIndex = findRowIndexByUuid(sheet, payload.uuid);
    if (rowIndex < 2) throw new Error('Fornecedor não encontrado.');

    updateRowByHeaderMap(sheet, headers, rowIndex, { ativo: 'INATIVO' });
    return { success: true, message: 'Fornecedor inativado com sucesso.' };
  });
}

function getFornecedorOptions() {
  return executeSafely(() => {
    const rows = readTable(SAE_TABLES.FORNECEDORES)
      .map(row => ({
        uuid: row.uuid,
        nome_fantasia: row.nome_fantasia,
        ativo: String(row.ativo || 'ATIVO').toUpperCase()
      }))
      .filter(row => row.ativo === 'ATIVO')
      .sort((a, b) => String(a.nome_fantasia || '').localeCompare(String(b.nome_fantasia || '')));

    return { success: true, data: rows };
  });
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

function importCSVData(csvContent, actorEmail) {
  return executeSafely(() => {
    if (actorEmail) {
      checkUserPermission(actorEmail, 'insumos');
    }

    if (!csvContent || typeof csvContent !== 'string') {
      throw new Error('Conteúdo CSV inválido.');
    }

    const rows = Utilities.parseCsv(csvContent.trim());
    if (rows.length < 2) {
      throw new Error('CSV sem dados para importação.');
    }

    const header = rows[0].map(h => normalizeHeader(h));
    const byHeader = expected => header.indexOf(expected);

    const idxCodigo = byHeader('codigo_ax');
    const idxDescricao = byHeader('descricao');
    const idxUnidade = byHeader('unidade');
    const idxLead = byHeader('lead_time');
    const idxEstoqueMin = byHeader('estoque_minimo');

    if (idxCodigo === -1 || idxDescricao === -1) {
      throw new Error('CSV deve conter ao menos as colunas codigo_ax e descricao.');
    }

    const sheet = getSheetOrThrow(SAE_TABLES.INSUMOS);
    const headers = getHeaders(sheet);
    const allRows = readTable(SAE_TABLES.INSUMOS);
    const byCodigo = {};
    allRows.forEach(row => {
      byCodigo[sanitizeCodigoAX(row.codigo_ax)] = row;
    });

    let imported = 0;
    let updated = 0;
    const inserts = [];

    rows.slice(1)
      .filter(row => row[idxCodigo] && row[idxDescricao])
      .forEach(row => {
        const codigoAX = sanitizeCodigoAX(row[idxCodigo]);
        const descricao = String(row[idxDescricao]).trim();
        const unidade = idxUnidade > -1 ? String(row[idxUnidade]).trim() : 'UN';
        const leadTime = idxLead > -1 ? sanitizeNumber(row[idxLead]) : 0;
        const estoqueMinimo = idxEstoqueMin > -1 ? sanitizeNumber(row[idxEstoqueMin]) : 0;

        const existing = byCodigo[codigoAX];

        if (existing) {
          const rowIndex = findRowIndexByUuid(sheet, existing.uuid);
          if (rowIndex > 1) {
            const map = {
              lead_time: leadTime,
              estoque_minimo: estoqueMinimo,
              descricao,
              unidade
            };
            updateRowByHeaderMap(sheet, headers, rowIndex, map);
            updated += 1;
          }
          return;
        }

        inserts.push({
          uuid: generateUUID(),
          codigo_ax: codigoAX,
          descricao,
          unidade,
          fornecedor_id: '',
          lead_time: leadTime,
          estoque_minimo: estoqueMinimo,
          consenso_dias: '',
          categoria: 'C',
          ativo: 'ATIVO',
          criado_em: new Date().toISOString()
        });
        imported += 1;
      });

    batchInsertRows(SAE_TABLES.INSUMOS, inserts);

    return {
      success: true,
      imported,
      updated,
      total_rows: rows.length - 1
    };
  });
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

function seedFornecedoresFromInsumos() {
  return executeSafely(() => {
    const insumos = readTable(SAE_TABLES.INSUMOS);
    const fornecedoresSheet = getSheetOrThrow(SAE_TABLES.FORNECEDORES);
    const fornecedores = readTable(SAE_TABLES.FORNECEDORES);

    const existingByName = {};
    fornecedores.forEach(f => {
      existingByName[String(f.nome_fantasia || '').toLowerCase()] = f;
    });

    const inserts = [];
    let updates = 0;

    insumos.forEach(insumo => {
      const nome = String(insumo.fornecedor || insumo.fornecedor_nome || '').trim();
      if (!nome) return;

      const key = nome.toLowerCase();
      let fornecedor = existingByName[key];

      if (!fornecedor) {
        fornecedor = {
          uuid: generateUUID(),
          nome_fantasia: nome,
          razao_social: nome,
          cnpj: '',
          contato: '',
          telefone: '',
          email: ''
        };
        inserts.push(fornecedor);
        existingByName[key] = fornecedor;
      }

      if (!insumo.fornecedor_id) {
        const rowIndex = findRowIndexByUuid(getSheetOrThrow(SAE_TABLES.INSUMOS), insumo.uuid);
        updateRowByHeaderMap(getSheetOrThrow(SAE_TABLES.INSUMOS), getHeaders(getSheetOrThrow(SAE_TABLES.INSUMOS)), rowIndex, {
          fornecedor_id: fornecedor.uuid
        });
        updates += 1;
      }
    });

    batchInsertRows(SAE_TABLES.FORNECEDORES, inserts);

    return {
      success: true,
      fornecedores_criados: inserts.length,
      insumos_atualizados: updates
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

function readTable(sheetName) {
  const sheet = getSheetOrThrow(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const headers = data[0].map(String);
  return data.slice(1)
    .filter(row => row.some(cell => cell !== ''))
    .map(row => headers.reduce((obj, header, idx) => {
      obj[header] = row[idx];
      return obj;
    }, {}));
}

function insertRow(sheetName, rowObject) {
  const sheet = getSheetOrThrow(sheetName);
  const headers = getHeaders(sheet);
  const row = headers.map(h => rowObject[h] !== undefined ? rowObject[h] : '');
  sheet.appendRow(row);
}

function batchInsertRows(sheetName, rows) {
  if (!rows || !rows.length) return;
  const sheet = getSheetOrThrow(sheetName);
  const headers = getHeaders(sheet);
  const values = rows.map(rowObj => headers.map(h => rowObj[h] !== undefined ? rowObj[h] : ''));
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

function findById(sheetName, uuid) {
  return readTable(sheetName).find(row => row.uuid === uuid);
}

function findByCodigoAX(sheetName, codigoAX) {
  const normalized = sanitizeCodigoAX(codigoAX);
  return readTable(sheetName).find(row => sanitizeCodigoAX(row.codigo_ax) === normalized);
}

function resolveInsumoForMovimentacao_(payload) {
  const insumoId = String(payload.insumo_id || '').trim();
  if (insumoId) {
    const byId = findById(SAE_TABLES.INSUMOS, insumoId);
    if (byId) return byId;
  }

  const codigoAX = sanitizeCodigoAX(payload.codigo_ax);
  if (codigoAX) {
    return findByCodigoAX(SAE_TABLES.INSUMOS, codigoAX);
  }

  return null;
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

function getCurrentStockByInsumo(insumoId) {
  const movimentos = readTable(SAE_TABLES.MOVIMENTACOES).map(sanitizeMovementRow);
  return movimentos
    .filter(m => m.insumo_id === insumoId)
    .reduce((acc, mov) => {
      if (mov.tipo === 'SAIDA') return acc - mov.quantidade;
      return acc + mov.quantidade;
    }, 0);
}

function applyStockMutation(saldo, tipo, quantidade) {
  if (tipo === 'SAIDA') return saldo - quantidade;
  return saldo + quantidade;
}

function findRowIndexByUuid(sheet, uuid) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const idxUuid = headers.indexOf('uuid');
  if (idxUuid === -1) return -1;

  for (let i = 1; i < data.length; i += 1) {
    if (String(data[i][idxUuid]) === String(uuid)) return i + 1;
  }
  return -1;
}

function updateRowByHeaderMap(sheet, headers, rowIndex, patch) {
  if (rowIndex < 2) return;
  Object.keys(patch).forEach(key => {
    const idx = headers.indexOf(key);
    if (idx > -1) {
      sheet.getRange(rowIndex, idx + 1).setValue(patch[key]);
    }
  });
}

function sanitizeMovementRow(row) {
  return {
    ...row,
    codigo_ax: sanitizeCodigoAX(row.codigo_ax),
    quantidade: sanitizeNumber(row.quantidade),
    data_iso: toIsoString(row.data_iso),
    tipo: String(row.tipo || '').toUpperCase()
  };
}


function generateUUID() {
  if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
    return Utilities.getUuid();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function sanitizeCodigoAX(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (/^0+\d+$/.test(raw)) {
    return String(Number(raw));
  }
  return raw;
}

function sanitizeNumber(value, fieldName) {
  if (value === '' || value === null || value === undefined) return 0;
  const normalized = String(value).replace(',', '.').trim();
  const num = Number(normalized);

  if (!Number.isFinite(num)) {
    if (fieldName) {
      throw new Error(`Campo numérico inválido: ${fieldName}`);
    }
    return 0;
  }
  return num;
}

function executeSafely(fn, contextName) {
  const context = contextName || resolveExecutionContext_();
  const start = new Date().getTime();
  try {
    const result = fn();
    const elapsedMs = new Date().getTime() - start;
    saeLog_('DEBUG', `executeSafely sucesso: ${context}`, {
      elapsedMs,
      resultShape: summarizeResultShape_(result)
    });
    return result;
  } catch (error) {
    const elapsedMs = new Date().getTime() - start;
    // Nota: idempotência de falha é tratada no escopo da função de negócio
    // (ex.: saveBulkMovimentacao chama IdempotencyService.markAsFailure no catch interno).
    saeLog_('ERROR', `executeSafely falha: ${context}`, {
      elapsedMs,
      error: error && error.stack ? String(error.stack) : (error && error.message ? error.message : String(error))
    });
    return {
      success: false,
      message: error && error.message ? error.message : String(error)
    };
  }
}

function saeLog_(level, message, data) {
  const payload = data ? ` | ${safeStringify_(data)}` : '';
  console.log(`${SAE_LOG_PREFIX} [${level}] ${message}${payload}`);
}

function safeStringify_(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function sanitizeForLog_(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value));
  if (clone.password !== undefined) clone.password = '[MASKED]';
  if (clone.senha !== undefined) clone.senha = '[MASKED]';
  return clone;
}

function summarizeResultShape_(result) {
  if (result === null || result === undefined) return String(result);
  if (Array.isArray(result)) return { type: 'array', length: result.length };
  if (typeof result !== 'object') return { type: typeof result };
  const keys = Object.keys(result);
  return {
    type: 'object',
    keys,
    success: result.success,
    dataLength: Array.isArray(result.data) ? result.data.length : undefined
  };
}

function resolveExecutionContext_() {
  try {
    const stack = new Error().stack || '';
    const lines = String(stack).split('\n').map(line => line.trim());
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line && line.indexOf('executeSafely') === -1 && line.indexOf('resolveExecutionContext_') === -1) {
        return line;
      }
    }
  } catch (error) {
    // noop
  }
  return 'unknown_context';
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

function getSheetOrThrow(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error(`Aba não encontrada: ${name}. Execute sae_setupDatabase() para criar a estrutura.`);
  }
  return sheet;
}

function getHeaders(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
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

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function toIsoString(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Data inválida para a movimentação.');
  }
  return date.toISOString();
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
