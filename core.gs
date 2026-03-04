/**
 * CORE INFRA - SAE
 *
 * ORDEM DE CARREGAMENTO: após models.gs e antes de services.gs/code.gs
 * DECLARA: logging, execução segura e utilitários compartilhados
 */

const SAE_LOG_PREFIX = '[SAE]';

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
