/**
 * FORNECEDORES SERVICE - SAE
 *
 * ORDEM DE CARREGAMENTO: após models/core/repositories/services e antes de code.gs
 * DECLARA: operações de catálogo de fornecedores e opções relacionadas
 */

function listFornecedores(payload) {
  return executeSafely(() => {
    const safe = payload || {};
    const page = Math.max(1, sanitizeNumber(safe.page || 1));
    const pageSize = Math.max(1, sanitizeNumber(safe.pageSize || 20));
    const query = String(safe.query || '').toLowerCase().trim();

    let rows = readTable(SAE_TABLES.FORNECEDORES).map(row => ({
      ...row,
      frete: sanitizeNumber(row.frete || 0),
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
      frete: sanitizeNumber(payload.frete || 0, 'frete'),
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
      ...entity,
      criado_em: new Date().toISOString()
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
        frete: sanitizeNumber(row.frete || 0),
        ativo: String(row.ativo || 'ATIVO').toUpperCase()
      }))
      .filter(row => row.ativo === 'ATIVO')
      .sort((a, b) => String(a.nome_fantasia || '').localeCompare(String(b.nome_fantasia || '')));

    return { success: true, data: rows };
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
          email: '',
          frete: 0,
          ativo: 'ATIVO',
          criado_em: new Date().toISOString()
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
