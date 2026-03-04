SAE - Sistema Apollo Enterprise: Programação de Insumos

Este documento detalha o status atual e o planejamento do módulo de Gestão de Programação de Insumos, projetado sob a arquitetura SAE para alta performance em ambiente Google Workspace.

🚀 Arquitetura do Sistema
Frontend: Vue 3 (via CDN) em Single-File WebApp.
Backend: Google Apps Script (V8 Engine) - Código.gs.
Banco de Dados: Google Sheets (Arquitetura de Entidades Normalizadas).
UI/UX: Glassmorphism Dark Mode, Mobile-first, Componentes SAE.

✅ O Que Foi Realizado (Mapeamento de Dados)
Até o momento, realizamos a análise técnica dos dados brutos fornecidos nos CSVs para estruturar as tabelas do Google Sheets:
Entidade: Insumos (Master Data):
Mapeado: Código AX, Descrição, Unidade de Medida, Lead Time e Fornecedor.
Entidade: Movimentações/Estoque:
Mapeado: Disponibilidade atual (Saldo), Consumo Médio (baseado em 2025) e Ponto de Ressuprimento (Q).
Lógica de Negócio:
Identificada a necessidade de cálculo de "Dias estimados para consumo" e "Giro de Estoque".
Definição da Classe ABC baseada no consumo (Gráficos de Controle).
Interface:
cad_insumos
uuid	codigo_ax	descricao	unidade	fornecedor_id	lead_time	estoque_minimo	consenso_dias	categoria	ativo	criado_em
mov_estoque
uuid	data_iso	insumo_id	codigo_ax	tipo	quantidade	usuario_email	observacao
cad_fornecedores
uuid	nome_fantasia	razao_social	cnpj	contato	telefone	email
sys_usuarios
uuid	nome	email	senha	permissao	paginas_acesso	status	ultimo_login
71d0b328-2848-4b3f-b71c-60578f9f5b39	Administrador	suaplanilhaexcel@gmail.com	admin123	ADMIN	ALL	ATIVO	2026-03-02T16:44:03.718Z
config_parametros
parametro	valor	descricao
dias_uteis_mes	25	Padrão de dias úteis para cálculo de consumo diário
janela_media_meses	12	Quantidade de meses retroativos para cálculo de média mensal
app_version	1.0.0	Versão atual do WebApp

Definido o padrão visual Glassmorphism para a exibição dos cards de insumos e alertas de estoque baixo.
📅 Próximos Passos (Task List)
🏗️ Fase 1: Backend & Database (GAS)
[X] Setup de Tabelas: Criar Google Sheets com abas DB_INSUMOS, DB_CONFIG e DB_MOVIMENTACOES.
[ ] Script de Carga: Desenvolver função importCSVData() para popular as tabelas iniciais.
[ ] Service Layer: Criar funções getInsumosData() e updateStockLevel() em Código.gs.
[ ] UUID & ISO: Implementar gerador de IDs únicos e normalização de datas ISO.

🎨 Fase 2: Frontend (Vue 3 + CSS)

[ ] Boilerplate SAE: Montar estrutura HTML com Vue 3, Sidebar e Header estilo Glassmorphism.

[ ] Dashboard Principal: Criar visualização de cards com indicadores (KPIs) de estoque crítico.

[ ] Search Engine: Implementar filtro reativo por Código AX ou Nome do Insumo.

[ ] Modais de Ação: Desenvolver modal para entrada de nova contagem ou ajuste de estoque.

⚙️ Fase 3: Inteligência & Alertas

[ ] Cálculo Ressuprimento: Implementar lógica de Ponto de Pedido (Lead Time x Consumo Diário).

[ ] Relatório de Compras: Gerar lista automática de insumos que precisam de pedido imediato.

[ ] Exportação: Função para exportar programação mensal atualizada.

📱 Fase 4: PWA & Deploy

[ ] Responsividade: Ajustar Grid para dispositivos móveis (Mobile-first).

[ ] Offline Cache: Configurar manifest para comportamento de App Nativo.

[ ] Deploy: Publicar como WebApp (Executar como: Usuário / Acesso: Qualquer pessoa com conta Google).

🛠️ Stack Tecnológica
Componente
Tecnologia
UI Framework
Vue 3 (CDN)
Styling

Custom CSS (Utility-first)
Icons
Lucide Icons / Material Icons
Database
Google Sheets API
Backend

Google Apps Script (V8)

Documento atualizado em: 2024-05-22

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

## 🧩 Plano de Refatoração por Sprints (Executado)

### Sprint 1 — Abstração & Segurança
- [x] `services.gs` criado com `SheetRepository`, `QueryBuilder`, `CacheManager`, `ValidationService` e `StockService`.
- [x] `models.gs` criado com schemas centrais (`SAE_SCHEMAS`), campos obrigatórios (`SAE_REQUIRED_FIELDS`) e thresholds de status (`ESTOQUE_STATUS`).
- [x] Timeout/retry/fila para chamadas `google.script.run` implementados no frontend (`runGAS` com backoff exponencial).
- [x] `AuditLogger` implementado e integrado no fluxo de movimentação unitária.

### Sprint 2 — Refatoração Backend
- [x] API Gateway inicial em `api.gs` com `doPost`, roteamento (`dispatchApiRequest_`) e resposta normalizada.
- [x] `code.gs` atualizado para delegar validações a `ValidationService` e mutações de saldo a `StockService`.
- [x] Cache de configuração versionado por `SAE_CACHE_VERSION` para evitar envenenamento após mudança de schema.
- [ ] Idempotência forte para upload em lote com chave de requisição (pendente).
- [ ] Testes unitários com mocks de GAS (pendente).

### Sprint 3 — Refatoração Frontend
- [x] Camada de comunicação única com timeout/retry/log estruturado/fila serial.
- [x] Debounce aplicado para carregamento de módulo (`loadCurrentModuleDebounced`).
- [x] Estado de módulo e modal extraído para factories (`createModuleState`, `createBulkModalState`) evitando vazamento entre operações.
- [ ] Composables/módulos separados em arquivos dedicados (pendente para próxima etapa).

### Sprint 4 — Integração & QA
- [ ] E2E workflow completo (pendente).
- [ ] Teste de performance com 10k+ linhas (pendente).
- [ ] Staging + validação de quotas GAS (pendente).

### 📌 Backlog Imediato
- [ ] Criar issue "Refatoração de Arquitetura SAE" no repositório remoto.
- [ ] Publicar contrato de API (request/response por endpoint) em documento dedicado.
- [ ] Criar branch de backup `legacy/2026-03` antes de nova rodada de refactor estrutural.
- [ ] Formalizar convenções de nomenclatura (público vs privado) em guia de contribuição.
