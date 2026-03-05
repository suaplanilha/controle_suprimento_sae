/**
 * REPOSITÓRIOS / DATA ACCESS - SAE
 *
 * ORDEM DE CARREGAMENTO: após core.gs e antes de services.gs/code.gs
 * DECLARA: helpers de acesso a abas/tabelas
 */

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


function deleteRowByUuidFast(sheetName, uuid) {
  const targetUuid = String(uuid || '').trim();
  if (!targetUuid) {
    throw new Error('UUID obrigatório para exclusão.');
  }

  const sheet = getSheetOrThrow(sheetName);
  const headers = getHeaders(sheet);
  const idxUuid = headers.indexOf('uuid');
  if (idxUuid === -1) {
    throw new Error(`Coluna uuid não encontrada na aba: ${sheetName}`);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const uuidRange = sheet.getRange(2, idxUuid + 1, lastRow - 1, 1);
  const match = uuidRange.createTextFinder(targetUuid).matchEntireCell(true).findNext();
  if (!match) return false;

  sheet.deleteRow(match.getRow());
  return true;
}
