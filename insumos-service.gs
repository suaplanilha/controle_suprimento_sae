/**
 * INSUMOS SERVICE - SAE
 *
 * ORDEM DE CARREGAMENTO: após models/core/repositories/services e antes de code.gs
 * DECLARA: operações de catálogo de insumos e importação CSV
 */

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

