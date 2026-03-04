Este documento descreve o status da evolução do módulo de Gestão de Programação de Insumos (GAS + Google Sheets), com foco em arquitetura orientada a serviços para operação em produção.

## 🚀 Arquitetura do Sistema
- **Frontend:** Vue 3 (CDN) em WebApp Google Apps Script.
- **Backend:** Google Apps Script (V8), com camada de serviços em `code.gs`.
- **Banco de Dados:** Google Sheets (entidades normalizadas por aba).
- **UI/UX:** Glassmorphism dark mode, mobile-first.

## ✅ Entregas Implementadas

### Banco de dados (setup e bootstrap)
- Estrutura de schema com criação de abas via `sae_setupDatabase()`.
- Tabelas: `cad_insumos`, `mov_estoque`, `cad_fornecedores`, `sys_usuarios`, `config_parametros`.
- Inclusão de coluna `senha` em `sys_usuarios` para autenticação real.
- Seed automático de parâmetros e usuário admin inicial.

### Service Layer (Backend GAS)
- `doLogin(credentials)` com validação de status, senha (quando disponível) e atualização de `ultimo_login`.
- `getInsumosData(filters)` com enriquecimento de métricas:
  - saldo atual;
  - consumo médio mensal e diário;
  - ponto de ressuprimento;
  - dias estimados para consumo;
  - giro de estoque;
  - status (`OK`, `ALERTA`, `CRITICO`).
- `updateStockLevel(payload)` para registrar entradas, saídas e ajustes.
- `importCSVData(csvContent)` para carga inicial de insumos com normalização de cabeçalhos.
- `getDashboardData()` com visão consolidada para cards/KPIs.

## 📐 Modelo de Dados

### `cad_insumos`
`uuid, codigo_ax, descricao, unidade, fornecedor_id, lead_time, estoque_minimo, consenso_dias, categoria, ativo, criado_em`

### `mov_estoque`
`uuid, data_iso, insumo_id, codigo_ax, tipo, quantidade, usuario_email, observacao`

### `cad_fornecedores`
`uuid, nome_fantasia, razao_social, cnpj, contato, telefone, email`

### `sys_usuarios`
`uuid, nome, email, senha, permissao, paginas_acesso, status, ultimo_login`

### `config_parametros`
`parametro, valor, descricao`

## 🧠 Roadmap Técnico (Próximas Fases)

### Fase 1 - Confiabilidade de Dados
- [ ] Adicionar regras de idempotência no `importCSVData` (evitar duplicidade por `codigo_ax`).
- [ ] Criar endpoint de conciliação de inventário por período.
- [ ] Criar testes automatizados com mocks de SpreadsheetApp.

### Fase 2 - Frontend Operacional
- [ ] Dashboard com KPIs críticos consumindo `getDashboardData`.
- [ ] Busca reativa (AX/descrição/status).
- [ ] Modal de movimentação com chamada para `updateStockLevel`.

### Fase 3 - Inteligência de Ressuprimento
- [ ] Cálculo ABC automático por janela móvel.
- [ ] Geração de lista de compras priorizada por lead time e criticidade.
- [ ] Exportação de programação mensal.

## 🛠️ Stack
- Vue 3 (CDN)
- Google Apps Script (V8)
- Google Sheets
- Lucide Icons

Documento atualizado em: 2026-03-02

## ✅ Atualização de Engenharia Backend (2026-03)
- Importador CSV idempotente por `codigo_ax` (atualiza `lead_time`/`estoque_minimo`/dados mutáveis sem duplicar UUID).
- Sanitização de entrada para `codigo_ax`, `quantidade`, `data_iso`.
- Função de snapshot semanal: `runWeeklyBackupSnapshot()` para backup de `cad_insumos` e `mov_estoque`.
- Curva ABC dinâmica baseada em saídas dos últimos N meses (configurável).
- Cálculo de consumo diário refinado com opção para meses sem movimentação (`ZERO`/`IGNORAR`).
- Motor de ressuprimento `calculateOrderPoint(insumo)` com ponto de pedido, sugestão de compra e data estimada de ruptura.
- Auditoria de movimentação com `saldo_anterior` e `saldo_posterior` anexados na observação.
- Middleware de autorização `checkUserPermission(email, page)`.
- Endpoint executivo `getExecutiveSummary()`.
- Cache de parâmetros com `PropertiesService` para reduzir leituras no Sheets.
- Função de validação técnica `test_runAllCalculations()`.
- Funções públicas retornando erro padronizado `{ success: false, message }`.


## 🧪 Preview Local e Preview GAS (sem quebrar produção)
- **Preview local:**
  1. No diretório do projeto, execute `python3 -m http.server 8000`
  2. Abra `http://localhost:8000/index.html`
- **Preview no GAS:**
  - Use URL de implantação `/dev` (teste) antes de promover para `/exec`.
  - O backend agora possui fallback de rota no `doGet(e)` para renderizar `index.html` mesmo com `pathInfo` inesperado.
- **Checklist antes de `clasp push` em produção:**
  - executar `./check_frontend_syntax.sh` para validar sintaxe do script Vue no `index.html`;
  - validar login, módulo movimentações manual, upload em massa e histórico;
  - validar `sae_setupDatabase()` em planilha de homologação;
  - só então publicar para produção.


## ✅ Validação rápida pré-push
- Rode `./check_frontend_syntax.sh` antes de `clasp push`.
- O script extrai o bloco `<script>` do `index.html` e valida com `node --check`.
- Isso evita regressões de runtime como `Invalid regular expression` em produção.

- Render local automatizado: `./check_render_local.sh` (usa curl e valida tokens essenciais da página).
- Análise de regressão do `index.html` contra baseline estável: `./analyze_index_regression.sh b8fc91f` (aponta diferenças de sintaxe/dependências potencialmente incompatíveis com o painel do GAS).
