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
