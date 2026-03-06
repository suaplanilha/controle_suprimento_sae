/**
 * Service layer e abstrações de dados (Sprint 1)
 *
 * ORDEM DE CARREGAMENTO: Carregue após models.gs
 * DEPENDE: SAE.REQUIRED_FIELDS (de models.gs)
 * DECLARA: SheetRepository, QueryBuilder, CacheManager, ValidationService, AuditLogger, StockService
 * USADO POR: code.gs
 */

class SheetRepository {
  constructor(sheetName) {
    this.sheetName = sheetName;
  }

  findAll() {
    return readTable(this.sheetName);
  }

  findById(uuid) {
    return findById(this.sheetName, uuid);
  }

  insert(row) {
    return insertRow(this.sheetName, row);
  }

  update(uuid, patch) {
    return updateRow(this.sheetName, uuid, patch);
  }

  delete(uuid) {
    const existing = this.findById(uuid);
    if (!existing) return false;
    return deleteRow(this.sheetName, uuid);
  }
}

class QueryBuilder {
  constructor(data) {
    this.data = Array.isArray(data) ? data.slice() : [];
    this.filters = [];
    this.sorter = null;
    this.maxRows = null;
  }

  where(field, op, value) {
    const supported = {
      '=': (row) => row[field] === value,
      '!=': (row) => row[field] !== value,
      'contains': (row) => String(row[field] || '').toLowerCase().includes(String(value || '').toLowerCase()),
      '>': (row) => sanitizeNumber(row[field]) > sanitizeNumber(value),
      '>=': (row) => sanitizeNumber(row[field]) >= sanitizeNumber(value),
      '<': (row) => sanitizeNumber(row[field]) < sanitizeNumber(value),
      '<=': (row) => sanitizeNumber(row[field]) <= sanitizeNumber(value)
    };

    if (!supported[op]) throw new Error(`Operador não suportado no QueryBuilder: ${op}`);
    this.filters.push(supported[op]);
    return this;
  }

  orderBy(field, asc) {
    this.sorter = { field, asc: asc !== false };
    return this;
  }

  limit(n) {
    this.maxRows = Math.max(0, sanitizeNumber(n));
    return this;
  }

  execute() {
    let result = this.data.slice();
    this.filters.forEach(fn => {
      result = result.filter(fn);
    });

    if (this.sorter) {
      const { field, asc } = this.sorter;
      result.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }

    if (this.maxRows !== null) {
      result = result.slice(0, this.maxRows);
    }

    return result;
  }
}

const ValidationService = {
  require(payload, key) {
    const required = SAE.REQUIRED_FIELDS[key] || [];
    validateRequired(payload, required);
  }
};

const StockService = {
  applyMutation(saldoAnterior, tipo, quantidade) {
    return applyStockMutation(saldoAnterior, tipo, quantidade);
  }
};

class CacheManager {
  constructor(props) {
    this.props = props || PropertiesService.getScriptProperties();
  }

  getJson(key) {
    const payload = this.props.getProperty(key);
    return payload ? JSON.parse(payload) : null;
  }

  setJson(key, value) {
    this.props.setProperty(key, JSON.stringify(value));
  }

  getNumber(key) {
    return Number(this.props.getProperty(key) || 0);
  }

  setNumber(key, value) {
    this.props.setProperty(key, String(value));
  }
}

/**
 * IdempotencyService — Controle de requisições duplicadas
 * Previne processamento duplicado de uploads em lote
 *
 * ORDEM DE CARREGAMENTO: Após models.gs, services.gs
 * DEPENDE: readTable, insertRow, updateRowByHeaderMap, findRowIndexByUuid, getSheetOrThrow, getHeaders, generateUUID, saeLog_
 * USADO POR: code.gs (função saveBulkMovimentacao)
 */
class IdempotencyService {
  static checkIfProcessed(requestId) {
    const rows = readTable(SAE_TABLES.IDEMPOTENCY);
    const existing = rows.find(r => String(r.request_id || '') === String(requestId));

    if (!existing) return null;

    if (existing.status === 'PROCESSANDO') {
      throw new Error('Requisição já em processamento. Aguarde alguns segundos e tente novamente.');
    }

    if (existing.status === 'SUCESSO') {
      saeLog_('INFO', 'IdempotencyService.checkIfProcessed: Cache hit', {
        requestId,
        timestamp: existing.timestamp_processado
      });
      return JSON.parse(existing.resultado_json || '{}');
    }

    if (existing.status === 'FALHA') {
      throw new Error(`Erro anterior registrado: ${existing.observacao || 'falha sem detalhes'}`);
    }

    return null;
  }

  static markAsProcessing(requestId, endpoint, usuarioEmail, payloadHash) {
    insertRow(SAE_TABLES.IDEMPOTENCY, {
      uuid: generateUUID(),
      request_id: requestId,
      endpoint,
      status: 'PROCESSANDO',
      resultado_json: '{}',
      payload_hash: String(payloadHash || ''),
      usuario_email: String(usuarioEmail || '').trim(),
      timestamp_processado: new Date().toISOString(),
      observacao: 'Em processamento...'
    });

    saeLog_('DEBUG', 'IdempotencyService.markAsProcessing: Requisição marcada', {
      requestId,
      endpoint
    });
  }

  static markAsSuccess(requestId, endpoint, resultado, usuarioEmail) {
    try {
      const rows = readTable(SAE_TABLES.IDEMPOTENCY);
      const sheet = getSheetOrThrow(SAE_TABLES.IDEMPOTENCY);
      const headers = getHeaders(sheet);

      const candidates = rows.filter(r => String(r.request_id || '') === String(requestId));
      if (!candidates.length) {
        saeLog_('WARN', 'IdempotencyService.markAsSuccess: Registro não encontrado', { requestId, endpoint });
        return false;
      }

      const processing = candidates.find(r => String(r.status || '').toUpperCase() === 'PROCESSANDO');
      const target = processing || candidates[candidates.length - 1];
      const rowIndex = findRowIndexByUuid(sheet, target.uuid);
      if (rowIndex < 2) {
        saeLog_('WARN', 'IdempotencyService.markAsSuccess: Índice de linha inválido', { requestId, endpoint, uuid: target.uuid });
        return false;
      }

      updateRowByHeaderMap(sheet, headers, rowIndex, {
        endpoint: endpoint || target.endpoint || '',
        status: 'SUCESSO',
        resultado_json: JSON.stringify(resultado),
        timestamp_processado: new Date().toISOString(),
        observacao: 'Processado com sucesso',
        usuario_email: String(usuarioEmail || target.usuario_email || '').trim()
      });

      saeLog_('INFO', 'IdempotencyService.markAsSuccess: Requisição finalizada', {
        requestId,
        endpoint,
        usuarioEmail,
        uuid: target.uuid
      });
      return true;
    } catch (error) {
      saeLog_('ERROR', 'IdempotencyService.markAsSuccess: Falha ao marcar sucesso', {
        requestId,
        endpoint,
        error: error && error.message ? error.message : String(error)
      });
      return false;
    }
  }

  static markAsFailure(requestId, endpoint, errorMessage, usuarioEmail) {
    const rows = readTable(SAE_TABLES.IDEMPOTENCY);
    const sheet = getSheetOrThrow(SAE_TABLES.IDEMPOTENCY);
    const headers = getHeaders(sheet);

    const existing = rows.find(r => String(r.request_id || '') === String(requestId));
    if (!existing) {
      saeLog_('WARN', 'IdempotencyService.markAsFailure: Registro não encontrado', { requestId });
      return;
    }

    const rowIndex = findRowIndexByUuid(sheet, existing.uuid);
    if (rowIndex < 2) return;

    updateRowByHeaderMap(sheet, headers, rowIndex, {
      status: 'FALHA',
      timestamp_processado: new Date().toISOString(),
      observacao: String(errorMessage || 'Erro desconhecido').substring(0, 255)
    });

    saeLog_('WARN', 'IdempotencyService.markAsFailure: Requisição marcada como falha', {
      requestId,
      endpoint,
      error: errorMessage,
      usuarioEmail
    });
  }
}

class AuditLogger {
  static logMovimentacao(entry) {
    const payload = {
      uuid: generateUUID(),
      data_iso: new Date().toISOString(),
      insumo_id: entry.insumo_id,
      codigo_ax: sanitizeCodigoAX(entry.codigo_ax),
      tipo: String(entry.tipo || '').toUpperCase(),
      quantidade: sanitizeNumber(entry.quantidade),
      usuario_email: String(entry.usuario_email || '').trim(),
      observacao: `[AUDIT] saldo_anterior=${sanitizeNumber(entry.saldo_anterior)}; saldo_posterior=${sanitizeNumber(entry.saldo_posterior)}; origem=${String(entry.origem || 'API')}`
    };

    insertRow(SAE_TABLES.MOVIMENTACOES, payload);
    return payload;
  }
}
