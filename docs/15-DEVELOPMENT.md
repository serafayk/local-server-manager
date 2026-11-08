# 15 — Desenvolvimento, execução e limitações (Fases 1–4)

> Documento operacional. A especificação continua em `01`–`14`.

## 1. Requisitos

- Windows 10/11 64-bit
- Node.js **24.x** (LTS)
- pnpm **9.x** (`corepack enable` é suficiente)
- Rust + MSVC Build Tools + WebView2 apenas a partir da Fase 4

## 2. Comandos

```powershell
pnpm install
pnpm typecheck     # tsc --noEmit em todo o workspace
pnpm lint
pnpm test          # Vitest (unitários + integração com processos reais)
pnpm format:check
pnpm build         # bundles do Engine + build da UI
pnpm check         # lint + typecheck + test + build
```

### Desktop (navegador, Fase 4a)

```powershell
# terminal 1
pnpm engine

# terminal 2
pnpm desktop
# abre http://localhost:1420
```

O Vite lê `engine/engine.json` em `/__engine` para descobrir porta e token.
Se o Engine reiniciar, recarregue a página. `LSM_DATA_DIR` deve apontar para a
mesma pasta nos dois processos quando usada.

### Engine em background (após build)

```powershell
pnpm engine
# ou: node apps/engine/dist/bootstrap/main.mjs
```

O Engine usa `%LOCALAPPDATA%\LocalServerManager` por padrão. `LSM_DATA_DIR` sobrescreve a raiz de dados.

### CLI de desenvolvimento

```powershell
pnpm cli
# ou com diretório isolado:
pnpm cli -- --data-dir "C:\tmp\lsm-dev"
# execução não interativa:
pnpm cli -- --exec-file .\roteiro.txt
```

Comandos disponíveis: `projects list|add|remove`, `start`, `stop`, `restart`, `status`, `logs`, `events`, `info`, `doctor`, `help`, `exit`.

Exemplo de cadastro sem shell:

```text
projects add --name "Fiscal API" --dir "C:\dev\fiscal" --pm pnpm --script dev --port 3000 --boot
projects add --name "Worker" --dir "C:\dev\worker" --exec node --arg worker.js --env NODE_ENV=development
```

`--pm` resolve o entrypoint JS do shim (`npm`/`pnpm`/`yarn`/`bun`) e executa com Node, sem `cmd.exe` na maioria dos casos (ADR-010).

## 3. Estrutura

```text
apps/engine/src/
  bootstrap/      createEngine, single-instance, main
  core/           event-bus, operation-queue, concurrency
  log-manager/    line-decoder, writer JSONL, ring buffer
  process-manager/spawn sem shell, stop de árvore
  supervisor/     supervisor, project-runtime, project-service
  dev-cli/        REPL e comandos
  persistence/    fachada dos repositórios
packages/
  contracts/      tipos, envelope, eventos, códigos de erro
  validation/     schemas Zod e normalização
  config/         paths e defaults
  database/       schema, migrator, repositórios SQL
  platform-win/   executáveis, shims, PID, taskkill
  shared/         clock, ids, logger, redação de segredos
tests/
  fixtures/       mini-projetos Node usados na integração
  helpers/        diretório temporário, espera, builder de config
```

## 4. O que a Fase 1 cobre

- Cadastro, listagem e remoção de projetos (nome único sem caixa).
- `start`, `stop`, `restart`, operações em lote e `startOnBoot`.
- Máquina de estados com 7 estados e `desiredState` persistido em memória.
- Logs `stdout`/`stderr`/`system` em JSONL por instância, com `sequence`, truncamento em 8 KB, ring buffer de 2.000 linhas e leitura do arquivo após o processo terminar.
- Mascaramento heurístico de segredos em logs.
- Encerramento de árvore de processos com verificação de PID.
- SQLite com migração versionada, backup e auditoria em `system_events`.
- Instância única por diretório de dados.
- CLI de desenvolvimento com REPL e script.

## 5. O que a Fase 2 adiciona

- **Auto-restart** com backoff exponencial (`min(base*2^(n-1), max)`), jitter opcional e `maxRetries` contando reinícios após a primeira execução.
- Estados `CRASHED → RESTARTING → STARTING → RUNNING`; `FAILED` quando o orçamento esgota.
- Stop durante o backoff cancela o retry; start manual cancela e zera o ciclo.
- Reset do contador após `stableAfterMs` em execução contínua (`stableAfterMs<=0` desliga o reset).
- Eventos `project.restart.scheduled`, `project.restart.started`, `project.recovery.exhausted` (barramento + `system_events`).
- **Reconciliação no boot:** instâncias não finalizadas viram `CRASHED/EXIT_UNEXPECTED`, com evento `engine.reconciliation.detected`; órfão comprovado por `StartTime` bloqueia `startOnBoot` e nunca é morto.
- **Retenção de logs** por projeto (`logging.retentionDays`), executada no boot e a cada 6 h, protegendo arquivos de instâncias ativas.
- 136 testes no total (34 novos nesta fase).

## 6. API local (Fase 3)

O Engine sobe uma API HTTP em `127.0.0.1` com porta efêmera e token por
execução. Os dados ficam em `engine/engine.json`:

```json
{
  "pid": 1234,
  "protocolVersion": 1,
  "dataDir": "C:\\Users\\<user>\\AppData\\Local\\LocalServerManager",
  "startedAt": "2026-11-07T20:00:00.000Z",
  "projects": 2,
  "api": {
    "host": "127.0.0.1",
    "port": 54321,
    "baseUrl": "http://127.0.0.1:54321",
    "token": "<token>",
    "websocketPath": "/api/v1/ws"
  }
}
```

```powershell
$engine = Get-Content "$env:LOCALAPPDATA\LocalServerManager\engine\engine.json" | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($engine.api.token)" }

Invoke-RestMethod "$($engine.api.baseUrl)/api/v1/health" -Headers $headers
Invoke-RestMethod "$($engine.api.baseUrl)/api/v1/projects" -Headers $headers

$body = @{
  name = 'Demo'
  workingDirectory = 'C:\dev\demo'
  runtime = @{ executable = 'node'; args = @('server.js') }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod "$($engine.api.baseUrl)/api/v1/projects" -Method Post `
  -Headers $headers -ContentType 'application/json' -Body $body
```

Regras de segurança: somente loopback, `Host` validado, CORS por allowlist,
token comparado em tempo constante, corpo máximo de 1 MB, sem stack trace na
resposta. Detalhes e rotas em [06-API-CONTRACTS.md](06-API-CONTRACTS.md) e
ADR-014.

## 7. Desktop (Fase 4)

Estrutura de `apps/desktop`:

```text
src/
  lib/        api.ts (cliente tipado), socket.ts (WS+reconexão), payload.ts
              (form <-> API), logs.ts (merge/filtro), format.ts
  stores/     app-store.ts (conexão + buffer de logs ao vivo)
  providers/  engine-provider.tsx (descoberta, cliente, socket)
  components/ layout, tabela, formulário em 3 etapas, LogViewer virtualizado
  pages/      dashboard, projetos, detalhes, logs, eventos, configurações
```

- **Descoberta:** em dev o Vite publica `/__engine`; no shell Tauri, o app lerá
  `window.__LSM_ENGINE__` (mesmo formato) via comando nativo.
- **Tempo real:** eventos WS atualizam o React Query e o buffer de logs;
  reconexão recarrega as consultas.
- **Logs:** histórico HTTP + fluxo ao vivo mesclados por `sequence`; lista
  virtualizada; filtros por stream e texto; auto-scroll opcional.
- **Cadastro:** 3 etapas (Projeto → Comando → Execução), com detecção read-only
  de `package.json`/lockfile e revisão do comando final.
- **Estados:** conexão, carregamento, vazio e erro são explícitos; ações
  destrutivas pedem confirmação; botões desabilitados explicam o motivo.

Testes da UI: `apps/desktop/src/**/*.test.{ts,tsx}` (Vitest + Testing Library,
jsdom por arquivo). O fluxo real foi validado no navegador contra o Engine
compilado: iniciar, logs ao vivo, parar e auditoria.

### Shell Tauri (Fase 4b)

```powershell
# desenvolvimento (compila Rust na primeira vez)
pnpm --filter @lsm/desktop tauri:dev

# executável + instalador NSIS
pnpm --filter @lsm/desktop tauri:build
```

- `prepare:engine` compila o Engine e copia `engine.mjs` + `node.exe` para
  `src-tauri/resources/engine/` (ignorado pelo git; ~93 MB).
- Ao abrir, o comando `ensure_engine` reutiliza um Engine já em execução. Se
  `engine.json` estiver órfão (processo morto), remove o arquivo e sobe o
  Engine embarcado, aguardando até 20 s.
- O Engine roda destacado (`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`).
- Fechar a janela minimiza para a bandeja; "Sair da interface" encerra apenas o
  app. "Abrir painel" restaura a janela.
- CSP restrita: `connect-src` apenas `127.0.0.1` (HTTP/WS) e IPC do Tauri.
- Requisitos: Rust estável (MSVC), VS Build Tools com C++ e WebView2.
- Diagnóstico do shell: `%LOCALAPPDATA%\LocalServerManager\engine\shell.log`
  (ou `LSM_DATA_DIR\engine\shell.log`) registra descoberta, caminhos de
  recurso, spawn e reutilização do Engine.

## 8. Monitoramento (Fase 5)

- **Health check** (config por projeto): HTTP com status esperado ou TCP
  `host:porta`; `intervalMs` (mín. 1 s), `timeoutMs`, `failureThreshold`.
  Saúde é exibida junto do estado (`RUNNING · UNHEALTHY`) e não altera o
  `status`. `restartOnUnhealthy` reinicia pelo caminho controlado respeitando
  `unhealthyRestartCooldownMs`.
- **Portas**: o start verifica a porta configurada com bind exclusivo em
  loopback e tenta identificar o dono via `netstat`. Conflito gera
  `project.port.conflict`, marca `portInUse` no snapshot e **não** mata o
  ocupante. A UI mostra um alerta na coluna Porta.
- **Métricas**: CPU normalizada por núcleo (delta entre amostras) e memória
  `WorkingSet64` via PowerShell em lote. Intervalo em Configurações
  (`metricsIntervalMs`, mín. 1 s). A primeira amostra de CPU é `—`.
  A aba **Métricas** do projeto e os cartões do Dashboard usam os eventos
  `project.metrics`/`system.metrics`; nada é persistido no SQLite.

## 9. Distribuição Windows (Fase 6)

```powershell
# instalador NSIS por usuário (sem admin)
pnpm --filter @lsm/desktop tauri:build
# saída: apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe
```

- **Autostart:** Configurações → "Iniciar o Engine no login". Cria a tarefa
  `Local Server Manager Engine` (`ONLOGON`, `LIMITED`, sem admin). O desinstalador
  remove a tarefa.
- **Backup:** Configurações → "Criar backup" grava `backups/manager-<timestamp>.sqlite`
  (WAL consolidado). A lista mostra data/tamanho.
- **Restauração:** para os projetos, agenda o restore e reinicia o Engine (no app)
  ou pede reinício manual (navegador). No boot, o Engine cria um backup
  `manager-pre-restore-*`, substitui o banco e remove o marcador.
- **Upgrade:** dados ficam em `%LOCALAPPDATA%\LocalServerManager`, fora da
  instalação. Reinstalar a versão anterior funciona como rollback.
- **Desinstalação:** remove a tarefa de autostart; **preserva** dados e pastas dos
  projetos.
- Guia do usuário: [16-USER-GUIDE.md](16-USER-GUIDE.md).

## 10. Melhorias da Fase 7

- **Grupos**: página própria, filtro na lista de projetos e campo no cadastro.
  Start/stop em lote por grupo; remover o grupo mantém os projetos.
- **Exportar/importar**: Configurações → "Configurações de projetos".
  O JSON não contém valores de variáveis sensíveis; a importação recria grupos
  por nome e reporta resultado por projeto.
- **Node instalado**: o cadastro lista NVM (`NVM_HOME`), instalação do sistema e
  o Node do Engine, preenchendo o caminho absoluto do executável.

## 11. Configuração assistida (Fase 8)

- **Adicionar pela raiz** (`POST /projects/scan-root`): detecta workspaces, lê portas de
  `.env`/`*.config.ts`/`-p` no script e o endpoint `/health`. A UI revisa antes de criar.
- **Seletor de pasta** nativo (`pick_folder`) no shell Tauri; no navegador resta o campo
  de texto.
- **Editar** disponível na lista e no detalhe; com o projeto ativo, oferece "Parar e
  editar". **Duplicar** cria outro projeto a partir da configuração.
- **Falha fatal não gera loop**: `EADDRINUSE`, build ausente, módulo ausente,
  `ECONNREFUSED` e `EACCES` interrompem o retry, marcam `FAILED` e expõem
  `lastFailureHint` no snapshot (evento `project.recovery.aborted`). O log do crash é
  preservado; corrija a causa e inicie manualmente.

## 12. Métricas por árvore e perfis de memória (Fase 9)

- `readProcessTreeMetrics` lê `Win32_Process` uma vez e soma working set,
  memória privada e CPU da raiz + descendentes (pnpm → tsx/node/next).
- `ProjectMetricsPayload` expõe `privateBytes`, `processCount` e `processes[]`.
- UI: coluna **Memória** na lista, cartões de privada/processos e tabela por
  processo no detalhe.
- `NODE_OPTIONS` por projeto via presets (Baixo/Médio/Alto/Personalizado).
  `--max-old-space-size` e `--max-semi-space-size` são aceitos; `--optimize-for-size`
  não é aceito em `NODE_OPTIONS`.

## 13. Túneis Cloudflare (Fase 10)

- Entidade própria (`tunnels`, migração v2) em três modos: `config.yml`, token do
  dashboard e quick tunnel.
- Start/stop/restart independentes, `start_on_boot`, logs e health via `/ready`.
- Portas de métricas 20241–20260; guarda contra dois túneis no mesmo config.yml ou
  na mesma porta quick.
- Token por `TUNNEL_TOKEN` (nunca em argv) e mascarado na API/UI.
- UI: página **Túneis** com URL/hostnames, ações e logs por túnel.

## 14. Execução direta e modo estático (Fase 11)

- `launchMode` (`auto`/`wrapper`/`direct`): resolve o script para `node`,
  `node --import tsx`, `next` ou `vite` sem pnpm/cmd/CLI extra.
  `tsx watch` só é convertido com `direct` explícito.
- `GET /projects/:id/launch-preview` mostra comando, motivo e processos evitados.
- `serveMode: static`: `StaticHostManager` serve `dist`/`build`/`out` dentro do
  Engine (SPA fallback, MIME, cache, traversal bloqueado); projeto sem PID.
- `POST /projects/:id/build` roda o script `build` one-shot com logs e timeout.
- Migração v3 adiciona `launch_mode`, `serve_mode`, `output_dir`.

## 15. Limitações conhecidas (Fase 7+)

1. **Assinatura e updater automático** — o instalador NSIS é gerado, mas assinatura de código e atualização automática ficam para a Fase 7.
2. **Sem single-instance do desktop** — abrir o app duas vezes abre duas janelas (o Engine continua único por diretório de dados).
3. **Sem adoção/limpeza de órfão** — a reconciliação bloqueia o boot e registra o PID; matar um órfão comprovado é ação manual até os Job Objects (Fase 7).
4. **CPU/memória são melhor esforço** — processos protegidos podem retornar `null`; a primeira leitura de CPU não tem delta.
5. **Dono da porta pode ser desconhecido** — `netstat` pode falhar ou exigir privilégios; o conflito continua sendo reportado.
6. **`shutdownBehavior=keep-running` não suportado** — exigiria logging desacoplado; a API responde `VALIDATION_ERROR`.
7. **Token em `engine.json`** — protegido apenas pela ACL do perfil do usuário até a Fase 6.
8. **Stop no Windows é forçado** — janela cooperativa curta (ADR-011).
9. **Retenção sem limite global de disco** — hoje é por projeto/dias.

## 16. Dados e privacidade

- Banco: `%LOCALAPPDATA%\LocalServerManager\data\manager.sqlite`
- Logs de processo: `%LOCALAPPDATA%\LocalServerManager\logs\<projectId>\<instanceId>.log`
- Log do Engine: `%LOCALAPPDATA%\LocalServerManager\engine\engine.log`
- Backups: `%LOCALAPPDATA%\LocalServerManager\backups\`

Nunca versione esses diretórios (já estão no `.gitignore`).
