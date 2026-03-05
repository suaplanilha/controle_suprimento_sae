/**
 * ANALYTICS SERVICE - SAE
 *
 * ORDEM DE CARREGAMENTO: após models/core/repositories/services e antes de code.gs
 * DECLARA: cálculos de KPIs, planejamento e enriquecimento de insumos
 */

function getInsumosDataCore(filters) {
  const safeFilters = filters || {};
  const insumos = readTable(SAE_TABLES.INSUMOS).filter(row => String(row.ativo || 'ATIVO').toUpperCase() !== 'INATIVO');
  const movimentos = readTable(SAE_TABLES.MOVIMENTACOES).map(sanitizeMovementRow);
  const configs = readConfigMap();
  const period = resolveAnalyticsPeriod_(safeFilters);

  const diasUteis = sanitizeNumber(configs.dias_uteis_mes || 25);
  const janelaMeses = sanitizeNumber(configs.janela_media_meses || 12);
  const tratarMesSemMovimentoComoZero = String(configs.tratar_mes_sem_movimento || 'ZERO').toUpperCase() !== 'IGNORAR';

  const abcMap = computeAbcCategoryMap(insumos, movimentos, janelaMeses);
  syncAbcCategories(insumos, abcMap);

  const data = insumos
    .map(insumo => {
      const enriched = enrichInsumo(insumo, movimentos, { diasUteis, janelaMeses, tratarMesSemMovimentoComoZero }, period);
      return {
        ...enriched,
        categoria: abcMap[insumo.uuid] || enriched.categoria || 'C'
      };
    })
    .filter(insumo => applyInsumoFilters(insumo, safeFilters))
    .sort((a, b) => String(a.codigo_ax).localeCompare(String(b.codigo_ax)));

  return {
    success: true,
    data,
    period,
    charts: {
      consumo_mensal: buildMonthlyConsumptionSeries_(movimentos, period)
    },
    summary: {
      total: data.length,
      criticos: data.filter(item => item.status_estoque === 'CRITICO').length,
      em_alerta: data.filter(item => item.status_estoque === 'ALERTA').length,
      saudaveis: data.filter(item => item.status_estoque === 'OK').length
    }
  };
}

function buildMonthlyConsumptionSeries_(movimentos, period) {
  const year = sanitizeNumber(period && period.year ? period.year : new Date().getFullYear());
  const selectedMonth = period && period.month ? sanitizeNumber(period.month) : null;

  const months = selectedMonth ? [selectedMonth] : Array.from({ length: 12 }, (_, idx) => idx + 1);
  const byMonth = {};
  months.forEach(m => {
    byMonth[m] = 0;
  });

  movimentos.forEach(mov => {
    if (mov.tipo !== 'SAIDA') return;
    const dt = new Date(mov.data_iso);
    if (Number.isNaN(dt.getTime()) || dt.getFullYear() !== year) return;
    const month = dt.getMonth() + 1;
    if (!Object.prototype.hasOwnProperty.call(byMonth, month)) return;
    byMonth[month] += sanitizeNumber(mov.quantidade);
  });

  return months.map(month => ({
    year,
    month,
    label: `${year}-${String(month).padStart(2, '0')}`,
    consumo: Number(byMonth[month].toFixed(2))
  }));
}

function enrichInsumo(insumo, movimentos, config, period) {
  const movs = movimentos.filter(m => m.insumo_id === insumo.uuid);

  const saldo = movs.reduce((acc, mov) => {
    const q = sanitizeNumber(mov.quantidade);
    if (mov.tipo === 'SAIDA') return acc - q;
    return acc + q;
  }, 0);

  const consumoMensal = calculateMonthlyConsumption(movs, config.janelaMeses, config.tratarMesSemMovimentoComoZero);
  const consumoDiario = config.diasUteis > 0 ? consumoMensal / config.diasUteis : 0;

  const withMetrics = {
    ...insumo,
    codigo_ax: sanitizeCodigoAX(insumo.codigo_ax),
    saldo_atual: Number(saldo.toFixed(2)),
    consumo_medio_mensal: Number(consumoMensal.toFixed(2)),
    consumo_medio_diario: Number(consumoDiario.toFixed(4))
  };

  const orderPoint = calculateOrderPoint(withMetrics);
  const consumoMesAtual = calculatePeriodConsumption(movs, {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1
  });
  const consumoPeriodo = calculatePeriodConsumption(movs, period);
  const mesesEstimadosConsumo = orderPoint.dias_estimados_consumo === null
    ? null
    : Number((Number(orderPoint.dias_estimados_consumo) / 30).toFixed(2));

  return {
    ...withMetrics,
    ponto_ressuprimento: orderPoint.ponto_ressuprimento,
    sugestao_compra: orderPoint.sugestao_compra,
    data_estimada_ruptura: orderPoint.data_estimada_ruptura,
    consumo_mes_atual: Number(consumoMesAtual.toFixed(2)),
    consumo_periodo: Number(consumoPeriodo.toFixed(2)),
    dias_estimados_consumo: orderPoint.dias_estimados_consumo,
    meses_estimados_consumo: mesesEstimadosConsumo,
    giro_estoque: consumoMensal > 0 ? Number((saldo / consumoMensal).toFixed(2)) : 0,
    status_estoque: computeStatus(saldo, orderPoint.ponto_ressuprimento)
  };
}

function resolveAnalyticsPeriod_(filters) {
  const now = new Date();
  const year = sanitizeNumber(filters && filters.year ? filters.year : now.getFullYear());
  const monthRaw = filters && filters.month !== undefined && filters.month !== null && filters.month !== ''
    ? sanitizeNumber(filters.month)
    : null;

  if (monthRaw !== null && (monthRaw < 1 || monthRaw > 12)) {
    throw new Error('Filtro month inválido. Use valores de 1 a 12.');
  }

  return {
    year,
    month: monthRaw
  };
}

function calculatePeriodConsumption(movs, period) {
  const safe = period || {};
  const year = sanitizeNumber(safe.year);
  const month = safe.month === null || safe.month === undefined || safe.month === '' ? null : sanitizeNumber(safe.month);

  return movs.reduce((acc, mov) => {
    if (mov.tipo !== 'SAIDA') return acc;
    const dt = new Date(mov.data_iso);
    if (Number.isNaN(dt.getTime())) return acc;
    if (dt.getFullYear() !== year) return acc;
    if (month !== null && (dt.getMonth() + 1) !== month) return acc;
    return acc + sanitizeNumber(mov.quantidade);
  }, 0);
}

function calculateOrderPoint(insumo) {
  const leadTime = sanitizeNumber(insumo.lead_time);
  const estoqueMinimo = sanitizeNumber(insumo.estoque_minimo);
  const consensoDias = sanitizeNumber(insumo.consenso_dias || 30);
  const consumoDiario = sanitizeNumber(insumo.consumo_medio_diario);
  const saldo = sanitizeNumber(insumo.saldo_atual);

  const pontoRessuprimento = Math.ceil((leadTime * consumoDiario) + estoqueMinimo);
  const estoqueAlvo = Math.ceil(consensoDias * consumoDiario);
  const sugestaoCompra = Math.max(0, Math.ceil(estoqueAlvo - saldo));

  let diasEstimados = null;
  let dataRuptura = null;

  if (consumoDiario > 0) {
    diasEstimados = Number((saldo / consumoDiario).toFixed(1));
    const ruptura = new Date();
    ruptura.setDate(ruptura.getDate() + Math.max(0, Math.floor(diasEstimados)));
    dataRuptura = ruptura.toISOString();
  }

  return {
    ponto_ressuprimento: pontoRessuprimento,
    sugestao_compra: sugestaoCompra,
    dias_estimados_consumo: diasEstimados,
    data_estimada_ruptura: dataRuptura
  };
}

function calculateMonthlyConsumption(movs, janelaMeses, treatMissingAsZero) {
  const months = Math.max(1, sanitizeNumber(janelaMeses));
  const monthTotals = {};

  for (let i = 0; i < months; i += 1) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthTotals[key] = 0;
  }

  movs.forEach(mov => {
    if (mov.tipo !== 'SAIDA') return;
    const dt = new Date(mov.data_iso);
    if (Number.isNaN(dt.getTime())) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (Object.prototype.hasOwnProperty.call(monthTotals, key)) {
      monthTotals[key] += sanitizeNumber(mov.quantidade);
    }
  });

  const values = Object.values(monthTotals);
  if (!values.length) return 0;

  if (treatMissingAsZero) {
    return values.reduce((acc, val) => acc + val, 0) / values.length;
  }

  const nonZero = values.filter(val => val > 0);
  if (!nonZero.length) return 0;
  return nonZero.reduce((acc, val) => acc + val, 0) / nonZero.length;
}

function computeAbcCategoryMap(insumos, movimentos, janelaMeses) {
  const months = Math.max(1, sanitizeNumber(janelaMeses));
  const limit = new Date();
  limit.setMonth(limit.getMonth() - months);

  const volumeByInsumo = {};
  insumos.forEach(i => {
    volumeByInsumo[i.uuid] = 0;
  });

  movimentos.forEach(mov => {
    if (mov.tipo !== 'SAIDA') return;
    const dt = new Date(mov.data_iso);
    if (Number.isNaN(dt.getTime()) || dt < limit) return;

    if (Object.prototype.hasOwnProperty.call(volumeByInsumo, mov.insumo_id)) {
      volumeByInsumo[mov.insumo_id] += sanitizeNumber(mov.quantidade);
    }
  });

  const ranking = Object.keys(volumeByInsumo)
    .map(id => ({ id, volume: volumeByInsumo[id] }))
    .sort((a, b) => b.volume - a.volume);

  const total = ranking.reduce((acc, item) => acc + item.volume, 0);
  if (total <= 0) {
    return ranking.reduce((acc, item) => {
      acc[item.id] = 'C';
      return acc;
    }, {});
  }

  let acumulado = 0;
  return ranking.reduce((acc, item) => {
    acumulado += item.volume;
    const percentual = (acumulado / total) * 100;
    if (percentual <= 80) {
      acc[item.id] = 'A';
    } else if (percentual <= 95) {
      acc[item.id] = 'B';
    } else {
      acc[item.id] = 'C';
    }
    return acc;
  }, {});
}

function syncAbcCategories(insumos, abcMap) {
  const sheet = getSheetOrThrow(SAE_TABLES.INSUMOS);
  const headers = getHeaders(sheet);
  const idxCategoria = headers.indexOf('categoria');
  const idxUuid = headers.indexOf('uuid');

  if (idxCategoria === -1 || idxUuid === -1) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i += 1) {
    const uuid = data[i][idxUuid];
    const newCategory = abcMap[uuid];
    if (!newCategory) continue;
    if (String(data[i][idxCategoria] || '') !== newCategory) {
      sheet.getRange(i + 1, idxCategoria + 1).setValue(newCategory);
    }
  }
}

function computeStatus(saldo, ponto) {
  if (saldo <= ponto * SAE.ESTOQUE_STATUS.CRITICO.threshold) return 'CRITICO';
  if (saldo <= ponto * SAE.ESTOQUE_STATUS.ALERTA.threshold) return 'ALERTA';
  return 'OK';
}

function applyInsumoFilters(insumo, filters) {
  if (filters.insumo_id && insumo.uuid !== filters.insumo_id) return false;

  if (filters.query) {
    const q = String(filters.query).toLowerCase().trim();
    const haystack = `${insumo.codigo_ax} ${insumo.descricao}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  if (filters.status && insumo.status_estoque !== filters.status) return false;

  return true;
}

function getExecutiveSummary(filters) {
  return executeSafely(() => {
    const result = getInsumosDataCore(filters || {});
    const data = result.data;

    const criticos = data.filter(item => item.status_estoque === 'CRITICO');
    const emRisco = criticos.reduce((acc, item) => acc + Number(item.saldo_atual || 0), 0);
    const leadTimeRisco = data.filter(item => Number(item.lead_time || 0) > Number(item.dias_estimados_consumo || 0));

    const estoqueAtual = data.reduce((acc, item) => acc + Number(item.saldo_atual || 0), 0);
    const demandaMensal = data.reduce((acc, item) => acc + Number(item.consumo_medio_mensal || 0), 0);
    const coberturaGlobalMeses = demandaMensal > 0 ? Number((estoqueAtual / demandaMensal).toFixed(2)) : null;

    return {
      success: true,
      generated_at: new Date().toISOString(),
      total_itens: data.length,
      itens_criticos: criticos.length,
      volume_em_risco: emRisco,
      itens_lead_time_maior_que_autonomia: leadTimeRisco.map(item => ({
        codigo_ax: item.codigo_ax,
        descricao: item.descricao,
        lead_time: item.lead_time,
        autonomia_dias: item.dias_estimados_consumo
      })),
      cobertura_estoque_global_meses: coberturaGlobalMeses
    };
  });
}
