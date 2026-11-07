# Changelog

Todas as mudanças relevantes do projeto. Formato inspirado em Keep a Changelog.

## [0.3.0] — 2026-11-07

### Fase 3 — API local e comunicação

- Servidor HTTP em `127.0.0.1` com porta efêmera, token de 32 bytes por execução e comparação em tempo constante.
- Descoberta pelo desktop via `engine/engine.json` (`host`, `port`, `baseUrl`, `token`, `websocketPath`).
- Proteções: validação de `Host` (DNS rebinding), CORS por allowlist, corpo máximo de 1 MB, `nosniff`, `no-store`, sem stack trace na resposta.
- Envelope `OperationResult` em todas as rotas; `requestId` de `X-Request-Id` ou gerado.
- Rotas: health, info, CRUD de projetos, start/stop/restart/status, logs, eventos, lote, settings, `detect` e `import` de pasta.
- `PUT /projects/:id` parcial com revalidação completa; projeto em execução retorna `ENGINE_BUSY`.
- WebSocket `/api/v1/ws`: snapshots ao conectar, eventos ao vivo, heartbeat de 30 s, backpressure com descarte de `project.log` e aviso `engine.notice`.
- Protocolo versionado (`/api/v1` + `X-Protocol-Version`).
- Configuração do Engine persistida (`batchConcurrency`, `logLevel`, `metricsIntervalMs`, `shutdownBehavior`); `keep-running` rejeitado até haver logging desacoplado.
- Novos contratos: `engine.notice`, `DOMAIN_EVENT_TYPES`, `ROUTE_NOT_FOUND`, `EngineApiInfo`, DTOs de detecção/importação.
- Correção no resolvedor de package manager: prefere `npm-cli.js` a `npm-prefix.js` em shims npm e descarta prefixos `VAR=`.
- 38 novos testes; total de 174.

### Limitações desta versão

- Named Pipe, health check, métricas, portas e desktop continuam pendentes (Fases 4–7).

## [0.2.0] — 2026-11-07

### Fase 2 — Resiliência

- `RecoveryManager` com backoff exponencial, jitter opcional, `RetryBudget` e reset após estabilidade (`FakeClock` nos testes).
- `maxRetries` conta reinícios após a primeira execução; 1ª falha agenda retry (attempt 1) e a falha `maxRetries+1` leva a `FAILED`.
- Ciclo `CRASHED → RESTARTING → STARTING → RUNNING`; durante o backoff o estado é `RESTARTING`.
- Stop manual durante o backoff cancela o retry; start manual cancela, zera o ciclo e inicia imediatamente.
- `stableAfterMs <= 0` desliga o reset automático (proteção contra loop infinito).
- Falha de spawn entra no mesmo caminho de recuperação do crash.
- Eventos `project.restart.scheduled`, `project.restart.started` e `project.recovery.exhausted` (barramento e auditoria).
- Reconciliação no boot: instâncias não finalizadas viram `CRASHED/EXIT_UNEXPECTED` com evento `engine.reconciliation.detected`.
- Propriedade de órfão comprovada por `StartTime` (tolerância de 2 s); órfão comprovado bloqueia `startOnBoot` e nunca é morto.
- PID vivo sem propriedade comprovada é tratado como possível reuso e não bloqueia o boot.
- Retenção de logs por projeto, executada no boot e a cada 6 h, preservando arquivos de instâncias ativas.
- Transições adicionais `CRASHED → FAILED`, `RESTARTING → STARTING` e `RESTARTING → STOPPING` (ADR-013).
- 34 novos testes; total de 136.

### Limitações desta versão

- Órfãos comprovados não são adotados nem removidos automaticamente.
- Health check, portas, métricas, API e desktop continuam fora (Fases 3–5).

## [0.1.0] — 2026-11-07

### Fase 0 — Fundação

- Monorepo pnpm com TypeScript strict, ESLint flat config, Prettier e Vitest.
- CI em `windows-latest` (format, lint, typecheck, test, build).
- `@lsm/contracts`: envelope `OperationResult`, códigos de erro, estados, eventos de domínio, DTOs e `PROTOCOL_VERSION`.
- `@lsm/validation`: schemas Zod de projeto, políticas, health check, logging e shutdown; normalização com defaults.
- `@lsm/config`: resolução de paths em `%LOCALAPPDATA%` e defaults documentados.
- `@lsm/shared`: `Clock` injetável (`FakeClock` para testes), IDs, `AppError`, logger estruturado com rotação e redação de segredos.
- `@lsm/database`: schema v1 corrigido, migrator com checksum e backup, repositórios SQL tipados sobre `node:sqlite`.
- `@lsm/platform-win`: resolução de executáveis sem shell, leitura de shims de package manager, verificação de PID por `StartTime` e `taskkill /T`.
- ADRs 008–011 (shutdown, base técnica, correções de schema/contrato, encerramento no Windows).

### Fase 1 — Engine mínimo

- `createEngine` com bootstrap, instância única por named pipe, `engine.json`, migrações e shutdown gracioso.
- Supervisor com `ProjectRuntime`, fila de operações por projeto, máquina de estados com `instanceId` e proteção contra callbacks de instância antiga.
- `spawn` com `shell:false`, `windowsHide`, captura de `stdout`/`stderr`, `exit`/`close` idempotentes.
- Cadastro/listagem/remoção de projetos; bloqueio de remoção de projeto em execução; `startOnBoot`.
- Logs JSONL por instância, com sequence, truncamento de linha, ring buffer, leitura do arquivo após o término e mascaramento de segredos.
- Encerramento de árvore de processos com verificação de propriedade do PID.
- Auditoria operacional em `system_events`.
- CLI de desenvolvimento com REPL, `--exec-file` e comando `doctor`.
- 102 testes (unitários + integração com processos reais no Windows).

### Limitações desta versão

- Sem auto-restart/backoff, reconciliação de órfãos, health check, métricas, API HTTP/WebSocket e interface desktop.
- Detalhes em `docs/15-DEVELOPMENT.md`.
