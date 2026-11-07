# 14 — Architecture Decision Records (ADR)

Este arquivo registra decisões arquiteturais. Novas decisões devem ser adicionadas no topo com data, contexto, decisão, alternativas e consequências.

## ADR-013 — Política de recuperação e semântica de retry

**Status:** Aceita (Fase 2)

**Contexto:** `docs/04-PROCESS-LIFECYCLE.md` define estados e fórmula de backoff, mas não fecha a contagem de tentativas, o estado durante a espera nem o comportamento de start manual durante o backoff.

**Decisão:**

1. `attempt` é 1-based e `delay = min(baseDelay * 2^(attempt-1), maxDelay)`. Jitter é simétrico e desligado por padrão (`jitterRatio=0`).
2. `maxRetries` conta reinícios após a primeira execução: a 1ª falha agenda retry (attempt 1); a falha `maxRetries+1` esgota.
3. Durante o backoff o projeto fica em `RESTARTING`. O retry executa `RESTARTING -> STARTING -> RUNNING`.
4. Stop manual durante o backoff cancela o timer e leva a `STOPPED`. Start manual cancela o timer, zera o ciclo e inicia imediatamente.
5. Esgotar tentativas leva a `FAILED` e `desiredState=STOPPED`. `FAILED` só sai por start manual.
6. `stableAfterMs` em execução contínua reseta o contador (`resetRetriesAfterStable`). `stableAfterMs<=0` desliga esse reset para não permitir loop infinito.
7. Falha de spawn (`SPAWN_FAILED`) entra no mesmo caminho de recuperação de um crash.
8. Transições adicionais: `CRASHED -> FAILED`, `RESTARTING -> STARTING` e `RESTARTING -> STOPPING`.

**Consequências:** o comportamento é previsível e testável com `FakeClock`; um projeto que falha cedo atinge `FAILED` em vez de reiniciar para sempre.

## ADR-012 — Reconciliação após queda do Engine

**Status:** Aceita (Fase 2)

**Contexto:** se o Engine morre sem shutdown, `process_instances` fica com registros sem encerramento e pode existir processo vivo que o novo Engine não pode supervisionar.

**Decisão:**

1. No boot, toda instância não finalizada é encerrada no banco como `CRASHED`/`EXIT_UNEXPECTED`, com evento `engine.reconciliation.detected` contendo `{pid, alive, ownershipVerified, action}`.
2. Propriedade só é considerada comprovada quando `StartTime` do PID coincide com `pid_started_at` (tolerância de 2 s).
3. O Engine **não adota** processos que não pode supervisionar e **não mata** por nome, porta ou PID não comprovado.
4. Órfão comprovado bloqueia o `startOnBoot` daquele projeto no boot atual, evitando duas instâncias. Start manual continua permitido e fica registrado.
5. PID vivo sem propriedade comprovada é tratado como possível reuso: registra aviso e não bloqueia o boot.

**Alternativas consideradas:** adotar o processo (impossível sem IPC/Job Object); matar por porta (proibido pela especificação).

**Consequências:** não há duplicação silenciosa de instâncias. A limpeza de órfão é manual nesta fase; Job Objects + adoção controlada ficam para a Fase 7.

## ADR-011 — Encerramento de árvore de processos no Windows

**Status:** Aceita (Fase 1)

**Contexto:** `child_process` no Windows não oferece `SIGTERM` real para outro processo. `taskkill /PID <pid> /T` sem `/F` não encerra aplicações de console; esperar o `gracefulTimeoutMs` completo apenas atrasa o Stop.

**Decisão:** Em Windows, tentar `taskkill /T` (sem `/F`) e aguardar no máximo 500 ms por confirmação; em seguida aplicar `taskkill /T /F`. Em POSIX, usar grupo de processos (`detached`) e `SIGTERM`/`SIGKILL`. O kill só é permitido sobre PID cuja propriedade foi registrada pelo Engine, com verificação de `StartTime` (`packages/platform-win/src/process-info.ts`) para evitar reuso de PID.

**Alternativas consideradas:** Job Objects na Fase 1 (exige módulo nativo, decisão adiada); `SIGTERM` puro (não funciona no Windows).

**Consequências:** Stop no Windows é efetivamente forçado, com janela curta de cooperação. A limitação está documentada; Job Objects entram na Fase 7 para cobrir processos reparentados. O exit code reportado após kill forçado pode ser 1/null — a causa real fica em `terminationReason`.

## ADR-010 — Correções de schema, contrato e execução identificadas na Fase 0/1

**Status:** Aceita

**Contexto:** A especificação tinha lacunas que impediriam Fases 2–5 (porta não modelada, ausência de `schema_migrations`, falta de campos de política, ambiguidade de shell no Windows).

**Decisão:**

1. `projects` passa a ter `port`, `port_source`, `startup_order`, `logging_json`, `shutdown_json` e `config_schema_version`; nome é único sem diferenciar maiúsculas.
2. `restart_policies` ganha `jitter_ratio`; `health_checks` ganha `unhealthy_restart_cooldown_ms`.
3. `process_instances` ganha `pid_started_at` (anti-reuso de PID) e `CHECK` nos estados.
4. `schema_migrations(version, name, checksum, applied_at)` com checksum SHA-256 e backup antes de migração pendente.
5. `runtime` é `{ executable, args }`: não existe campo capaz de habilitar shell.
6. `.cmd`/`.bat` não podem ser executados com `shell:false` (CVE-2024-27980). O Engine resolve o entrypoint `.js` do shim de `npm`/`pnpm`/`yarn`/`bun` e executa com Node. Se o shim não expuser entrypoint, usa `cmd.exe` apenas com caminho resolvido e nome de script validado (`^[A-Za-z0-9:_.-]{1,64}$`), registrando aviso.
7. `startupOrder` define ordem de boot. Grupos continuam organização visual; dependências ficam para a Fase 7.
8. Códigos de erro adicionados: `EXECUTABLE_REQUIRES_SHELL`, `PROJECT_NAME_IN_USE`, `INVALID_STATE_TRANSITION`, `STORAGE_ERROR`, `PROTOCOL_VERSION_MISMATCH`, `UNSUPPORTED_PLATFORM`, `LOG_WRITE_FAILED`.
9. `CRASHED -> STARTING` é transição válida (start manual após crash), além das transições do documento original.

**Consequências:** Schema e contratos ficam alinhados ao comportamento real; qualquer mudança futura exige nova migração versionada.

## ADR-009 — Base técnica da fundação

**Status:** Aceita

**Contexto:** Fase 0 precisava de build, banco, logs e tipagem sem aumentar o risco de empacotamento do Engine junto ao Tauri.

**Decisão:**

- Monorepo _source-first_: pacotes exportam TypeScript direto; `tsc --noEmit` faz typecheck e o `esbuild` gera apenas os bundles do Engine.
- SQLite via `node:sqlite` (`DatabaseSync`) com repositórios SQL tipados. Sem ORM e sem módulo nativo.
- Logger estruturado próprio (JSON por linha, sinks stdout/arquivo, rotação por tamanho, mascaramento). Sem `pino`, para evitar dependências de transporte/worker no bundle.

**Alternativas consideradas:** Drizzle (mais uma camada sem ganho imediato); `better-sqlite3` (módulo nativo, complica build para Tauri); `pino` (bom, mas desnecessário para o volume do plano de controle).

**Consequências:** Zero dependência nativa e build do Engine em ~0,4 s. A API de `node:sqlite` ainda evolui; todo acesso está isolado em `packages/database`, permitindo trocar o driver sem tocar no Engine.

## ADR-008 — Encerramento do Engine para os projetos

**Status:** Aceita

**Contexto:** `docs/03-ENGINE.md §10` definia o comportamento como "explícito e configurável", sem default, deixando em aberto o risco de processos órfãos sem supervisor.

**Decisão:** No encerramento explícito do Engine, parar todos os projetos de forma graciosa (`shutdownBehavior = "stop-all"`). Fechar apenas a janela/desktop não para projeto algum. O valor fica persistível em `settings` para evolução futura.

**Alternativas consideradas:** deixar processos rodando (exigiria reconciliá-los no próximo boot sem garantia de propriedade); serviço Windows (fora do MVP).

**Consequências:** Nenhum processo fica sem supervisor. Projetos `startOnBoot=true` voltam no próximo boot do Engine, conforme RF-009.

## ADR-001 — Engine independente do Desktop

**Status:** Aceita

**Contexto:** Fechar a janela não pode encerrar os servidores.

**Decisão:** Engine Node.js separado do processo Tauri/React.

**Consequências:** Mais robustez e complexidade de instalação/comunicação. A UI pode ser reiniciada sem afetar processos.

## ADR-002 — Supervisor próprio no MVP

**Status:** Aceita

**Contexto:** O produto precisa de controle detalhado do ciclo de vida e políticas de recuperação.

**Decisão:** Implementar supervisor com `child_process.spawn`, sem depender de PM2.

**Consequências:** Maior controle, mas responsabilidade integral por concorrência, restart, logs e processos filhos. PM2 pode ser reavaliado futuramente como alternativa, não como requisito.

## ADR-003 — Tauri 2 + React

**Status:** Aceita (decisão final em 2026-11-07)

**Contexto:** Aplicativo desktop leve com interface web moderna. Engine permanece Node.js.

**Decisão:** Tauri 2 para shell desktop e React/TypeScript para UI. O Engine será empacotado como sidecar (`node.exe` + bundle `esbuild`). Rust, MSVC Build Tools e WebView2 serão instalados antes da Fase 4 — as Fases 0–1 não dependem desse toolchain.

**Consequências:** Integração nativa exige conhecimento de Rust/Tauri. O Engine permanece Node.js e independente do processo da UI.

## ADR-004 — SQLite

**Status:** Aceita

**Contexto:** Aplicação local, dados estruturados e volume moderado de eventos.

**Decisão:** SQLite para configurações e histórico; arquivos para logs de processo.

**Consequências:** Instalação simples e backup local. Exige migrações e controle de concorrência.

## ADR-005 — Comunicação local privada

**Status:** Aceita

**Contexto:** A API tem poder de iniciar comandos no computador.

**Decisão:** Named Pipe com ACL no Windows como preferência; HTTP loopback autenticado como alternativa de desenvolvimento.

**Consequências:** Reduz superfície de ataque e exige implementação/testes de autenticação e reconexão.

## ADR-006 — Estado e saúde separados

**Status:** Aceita

**Contexto:** Processo ativo pode estar sem responder.

**Decisão:** Estado do processo e resultado de health check são dimensões diferentes.

**Consequências:** UI pode exibir `RUNNING · UNHEALTHY`; recuperação por health check é opcional e controlada.

## ADR-007 — Inicialização no login primeiro

**Status:** Aceita para MVP

**Contexto:** Serviço Windows adiciona complexidade de permissões e instalação.

**Decisão:** Agendador de Tarefas no login do usuário. Serviço Windows fica para evolução.

**Consequências:** Projetos começam após login, não necessariamente antes dele.
