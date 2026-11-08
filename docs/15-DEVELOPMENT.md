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

## 8. Limitações conhecidas (Fase 5+)

1. **Instalador/assinatura/updater** — `tauri build` gera NSIS, mas assinatura, atualização e desinstalação guiada ficam na Fase 6.
2. **Sem single-instance do desktop** — abrir o app duas vezes abre duas janelas (o Engine continua único por diretório de dados).
3. **Sem adoção/limpeza de órfão** — a reconciliação bloqueia o boot e registra o PID; matar um órfão comprovado é ação manual até os Job Objects (Fase 7).
4. **Sem health check, portas e métricas** — Fase 5; a aba de métricas e os campos de health existem, mas a execução não.
5. **`shutdownBehavior=keep-running` não suportado** — exigiria logging desacoplado; a API responde `VALIDATION_ERROR`.
6. **Token em `engine.json`** — protegido apenas pela ACL do perfil do usuário até a Fase 6.
7. **Stop no Windows é forçado** — janela cooperativa curta (ADR-011).
8. **Retenção sem limite global de disco** — hoje é por projeto/dias.

## 9. Dados e privacidade

- Banco: `%LOCALAPPDATA%\LocalServerManager\data\manager.sqlite`
- Logs de processo: `%LOCALAPPDATA%\LocalServerManager\logs\<projectId>\<instanceId>.log`
- Log do Engine: `%LOCALAPPDATA%\LocalServerManager\engine\engine.log`
- Backups: `%LOCALAPPDATA%\LocalServerManager\backups\`

Nunca versione esses diretórios (já estão no `.gitignore`).
