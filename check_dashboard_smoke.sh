#!/usr/bin/env bash
set -euo pipefail

node <<'JS'
const fs = require('fs');

function must(haystack, regex, msg) {
  if (!regex.test(haystack)) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`OK: ${msg}`);
}

const index = fs.readFileSync('index.html', 'utf8');
const analytics = fs.readFileSync('analytics-service.gs', 'utf8');
const facade = fs.readFileSync('facade-support.gs', 'utf8');

// Frontend: filtros enviados para getDashboardData
must(index, /dashboardFilterPayload\s*=\s*\(\)\s*=>/, 'dashboardFilterPayload existe');
must(index, /year\s*,\s*\n\s*month\s*,\s*\n\s*query:\s*String\(/, 'payload inclui year/month/query');
must(index, /Ano inválido para dashboard/, 'validação de ano inválido');
must(index, /Mês inválido para dashboard/, 'validação de mês inválido');

// Frontend: tabela KPI mantém campos essenciais
must(index, /Consumo Período/, 'coluna Consumo Período');
must(index, /Últ\. Mov\. Período/, 'coluna Últ. Mov. Período');
must(index, /Disponível/, 'coluna Disponível');
must(index, /Ponto Ressupr\./, 'coluna Ponto Ressupr.');
must(index, /Dias/, 'coluna Dias');
must(index, /Meses/, 'coluna Meses');
must(index, /Média Mensal/, 'coluna Média Mensal');
must(index, /Lead Time/, 'coluna Lead Time');
must(index, /Consenso/, 'coluna Consenso');
must(index, /data estimada de ruptura/i, 'tabela operacional de ruptura');

// Backend analytics contract
must(analytics, /summary:\s*\{\s*\n\s*total:/, 'summary.total no analytics');
must(analytics, /period,/, 'period no retorno analytics');
must(analytics, /charts:\s*\{\s*\n\s*consumo_mensal:/, 'charts.consumo_mensal no retorno analytics');
must(analytics, /ultima_movimentacao_periodo:/, 'campo ultima_movimentacao_periodo no analytics');

// Observabilidade/facade consistency
must(facade, /summary\s*\?\s*insumosResult\.summary\.total\s*:/, 'log usa summary.total');

console.log('Dashboard smoke checks passed.');
JS
