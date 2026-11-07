# 15 — Desenvolvimento, execução e limitações (Fases 1–2)

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
pnpm build         # bundles do Engine em apps/engine/dist
pnpm check         # lint + typecheck + test + build
```

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

## 6. Limitações conhecidas (Fase 3+)

1. **Sem adoção/limpeza de órfão** — a reconciliação bloqueia o boot e registra o PID; matar um órfão comprovado é ação manual até os Job Objects (Fase 7).
2. **Sem health check, portas e métricas** — Fase 5.
3. **Sem API HTTP/WebSocket** — Fase 3; a CLI roda o Engine no próprio processo.
4. **Sem interface desktop** — Fase 4.
5. **Empacotamento do Engine como sidecar Tauri** — será validado antes da Fase 4.
6. **Stop no Windows é forçado** — janela cooperativa curta (ADR-011); Job Objects na Fase 7.
7. **Retenção não tem limite global de disco** — hoje é por projeto/dias; limite global entra junto da UI de configurações.

## 7. Dados e privacidade

- Banco: `%LOCALAPPDATA%\LocalServerManager\data\manager.sqlite`
- Logs de processo: `%LOCALAPPDATA%\LocalServerManager\logs\<projectId>\<instanceId>.log`
- Log do Engine: `%LOCALAPPDATA%\LocalServerManager\engine\engine.log`
- Backups: `%LOCALAPPDATA%\LocalServerManager\backups\`

Nunca versione esses diretórios (já estão no `.gitignore`).
