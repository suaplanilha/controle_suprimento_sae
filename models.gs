/**
 * SISTEMA APOLLO ENTERPRISE (SAE) — Modelos e Constantes Centralizadas
 *
 * ORDEM DE CARREGAMENTO: Carregue este arquivo PRIMEIRO
 * DECLARA: var SAE (namespace global com todas as constantes)
 * USADO POR: code.gs, services.gs, api.gs
 */

var SAE = {
  CACHE_VERSION: 'v2',

  SCHEMAS: {
    INSUMO: {
      uuid: 'string|required|uuid',
      codigo_ax: 'string|required|sanitizeCodigoAX',
      descricao: 'string|required',
      unidade: 'string|required',
      lead_time: 'number|required|min:0',
      estoque_minimo: 'number|required|min:0',
      consenso_dias: 'number|required|min:0',
      categoria: 'string|required|enum:A,B,C'
    },
    MOVIMENTACAO: {
      uuid: 'string|required|uuid',
      data_iso: 'string|required|isoDate',
      insumo_id: 'string|required',
      codigo_ax: 'string|required|sanitizeCodigoAX',
      tipo: 'string|required|enum:ENTRADA,SAIDA,AJUSTE',
      quantidade: 'number|required|gt:0',
      usuario_email: 'string|required|email'
    }
  },

  REQUIRED_FIELDS: {
    LOGIN: ['email'],
    LOGIN_WITH_PASSWORD: ['email', 'password'],
    MOVIMENTACAO: ['insumo_id', 'tipo', 'quantidade', 'usuario_email'],
    BULK_MOVIMENTACAO: ['rows', 'usuario_email', 'data_iso']
  },

  ESTOQUE_STATUS: {
    CRITICO: { threshold: 0.5, label: 'Crítico', color: '#ef4444' },
    ALERTA: { threshold: 1.0, label: 'Alerta', color: '#f59e0b' },
    OK: { threshold: Infinity, label: 'OK', color: '#10b981' }
  }
};

SAE.UI_TOKENS = {
  COLORS: {
    AZUL_ESCURO: '#0f172a',
    AZUL_CLARO: '#38bdf8',
    ALERTA: SAE.ESTOQUE_STATUS.ALERTA.color,
    CRITICO: SAE.ESTOQUE_STATUS.CRITICO.color,
    SUCESSO: SAE.ESTOQUE_STATUS.OK.color
  }
};
