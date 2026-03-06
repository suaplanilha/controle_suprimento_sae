/**
 * MOVIMENTAÇÕES SERVICE - SAE
 *
 * ORDEM DE CARREGAMENTO: após models/core/repositories/services e antes de code.gs
 * DECLARA: funções públicas e helpers do módulo de movimentações
 */

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


function deleteMovimentacao(payload) {
  return executeSafely(() => {
    validateRequired(payload, ['uuid']);
    checkUserPermission(payload.usuario_email, 'movimentacoes');

    const deleted = deleteRowByUuidFast(SAE_TABLES.MOVIMENTACOES, payload.uuid);
    if (!deleted) {
      throw new Error('Movimentação não encontrada para exclusão.');
    }

    return {
      success: true,
      message: 'Movimentação excluída com sucesso.',
      uuid: String(payload.uuid)
    };
  }, 'deleteMovimentacao');
}

function listMovimentacoes(payload) {
  return executeSafely(() => {
    const safe = payload || {};
    const page = Math.max(1, sanitizeNumber(safe.page || 1));
    const pageSize = Math.max(1, sanitizeNumber(safe.pageSize || 20));

    const insumos = readTable(SAE_TABLES.INSUMOS);
    const descricaoByUuid = {};
    const descricaoByCodigoAX = {};

    insumos.forEach(row => {
      const ativo = String(row.ativo || 'ATIVO').toUpperCase();
      const descricao = String(row.descricao || '').trim();
      const uuid = String(row.uuid || '').trim();
      const codigoAX = sanitizeCodigoAX(row.codigo_ax);
      if (ativo === 'INATIVO' || !descricao) return;

      if (uuid) {
        descricaoByUuid[uuid] = descricao;
      }
      if (codigoAX) {
        descricaoByCodigoAX[codigoAX] = descricao;
      }
    });

    let rows = readTable(SAE_TABLES.MOVIMENTACOES)
      .map(sanitizeMovementRow)
      .map(row => ({
        ...row,
        descricao: descricaoByUuid[String(row.insumo_id)] || descricaoByCodigoAX[sanitizeCodigoAX(row.codigo_ax)] || ''
      }));

    if (safe.codigo_ax) {
      const targetAX = sanitizeCodigoAX(safe.codigo_ax);
      rows = rows.filter(row => sanitizeCodigoAX(row.codigo_ax) === targetAX);
    }

    if (safe.tipo) {
      rows = rows.filter(row => String(row.tipo || '').toUpperCase() === String(safe.tipo).toUpperCase());
    }

    rows.sort((a, b) => String(b.data_iso || '').localeCompare(String(a.data_iso || '')));
    return paginateRows(rows, page, pageSize);
  }, 'listMovimentacoes');
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

function sanitizeMovementRow(row) {
  return {
    ...row,
    codigo_ax: sanitizeCodigoAX(row.codigo_ax),
    quantidade: sanitizeNumber(row.quantidade),
    data_iso: toIsoString(row.data_iso),
    tipo: String(row.tipo || '').toUpperCase()
  };
}

