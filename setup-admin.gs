/**
 * SETUP / ADMIN / TEST HARNESS - SAE
 *
 * ORDEM DE CARREGAMENTO: após models/core/repositories/services e antes de code.gs
 * DECLARA: setup de estrutura, snapshot administrativo, include e testes internos
 */

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

