/**
 * FACADE SUPPORT - SAE
 *
 * ORDEM DE CARREGAMENTO: após setup-admin.gs e antes de code.gs
 * DECLARA: helpers compartilhados e serviços internos usados pela fachada
 */

function renderWebApp_(e) {
  const path = String((e && e.pathInfo) || '').trim().toLowerCase();
  saeLog_('DEBUG', 'renderWebApp_ iniciado', { path });

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

function doLoginService_(credentials) {
  return executeSafely(() => {
    saeLog_('INFO', 'doLogin recebido', {
      email: credentials && credentials.email ? String(credentials.email).trim().toLowerCase() : ''
    });

    ValidationService.require(credentials, 'LOGIN');

    const usersSheet = getSheetOrThrow(SAE_TABLES.USUARIOS);
    const headers = getHeaders(usersSheet);
    const hasPasswordColumn = headers.includes('senha');

    const users = readTable(SAE_TABLES.USUARIOS);
    const user = users.find(row => String(row.email).toLowerCase() === String(credentials.email).toLowerCase());

    if (!user) {
      saeLog_('WARN', 'doLogin usuário não encontrado', { email: credentials.email });
      throw new Error('Usuário não encontrado.');
    }

    if (String(user.status).toUpperCase() !== 'ATIVO') {
      saeLog_('WARN', 'doLogin usuário inativo', { email: user.email, status: user.status });
      throw new Error('Usuário inativo. Contate o administrador.');
    }

    if (hasPasswordColumn) {
      ValidationService.require(credentials, 'LOGIN_WITH_PASSWORD');
      const inputPasswordRaw = String(credentials.password || '');
      const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, inputPasswordRaw);
      const inputPasswordHash = Utilities.base64Encode(digest);
      const expectedPasswordHash = String(user.senha || '');

      if (!expectedPasswordHash || expectedPasswordHash !== inputPasswordHash) {
        saeLog_('WARN', 'doLogin senha inválida', { email: user.email, hasPasswordColumn });
        throw new Error('Senha inválida.');
      }
    }

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

function getInsumosDataService_(filters) {
  return executeSafely(() => {
    saeLog_('DEBUG', 'getInsumosData chamado', { filters: sanitizeForLog_(filters) });
    return getInsumosDataCore(filters);
  }, 'getInsumosData');
}

function getDashboardDataService_(filters) {
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
