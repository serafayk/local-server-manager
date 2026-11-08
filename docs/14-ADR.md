# 14 — Architecture Decision Records (ADR)

Este arquivo registra decisões arquiteturais. Novas decisões devem ser adicionadas no topo com data, contexto, decisão, alternativas e consequências.

## ADR-018 — Grupos, exportação/importação e múltiplas versões de Node

**Status:** Aceita (Fase 7)

**Contexto:** Melhorias pós-MVP sem alterar a arquitetura do Engine.

**Decisão:**

1. **Grupos** são organização visual (`project_groups` + `projects.group_id`), com CRUD na API/UI e start/stop em lote por grupo. Não criam dependência; dependências reais ficam para uma fase futura.
2. **Exportação** gera `{schemaVersion: 1, exportedAt, projects[]}` sem IDs internos e **sem valores de variáveis sensíveis**. As chaves omitidas são listadas em `maskedEnvironmentKeys`. Grupos são exportados por nome.
3. **Importação** valida o bundle com Zod, recria grupos por nome (`ensureByName`), gera novos IDs e retorna resultado por projeto. Conflito de nome retorna `PROJECT_NAME_IN_USE` sem cancelar os demais. Limite de 500 projetos e corpo HTTP de 1 MB.
4. **Múltiplas versões de Node**: detecção read-only de instalações NVM (`NVM_HOME`/`%APPDATA%\nvm`), Node do sistema e o Node do Engine; a UI preenche o caminho absoluto do `node.exe`. Nada executa `nvm use`.

**Alternativas consideradas:** exportar segredos (rejeitado); IDs estáveis na importação (colidiriam entre máquinas); dependências entre projetos nesta fase (escopo maior).

**Consequências:** configurações são portáveis e auditáveis. Renomear grupo não afeta projetos; excluir grupo apenas limpa `group_id`.

## ADR-017 — Autostart, backup/restauração e distribuição Windows

**Status:** Aceita (Fase 6)

**Contexto:** O MVP precisa iniciar com o Windows, permitir desativar, preservar dados em upgrade/desinstalação e oferecer recuperação do SQLite.

**Decisão:**

1. **Autostart** via Agendador de Tarefas (`schtasks /SC ONLOGON /RL LIMITED`), tarefa `Local Server Manager Engine`, comandada pelo shell Tauri (`autostart_status`/`set_autostart`) e apontando para os recursos empacotados (`node.exe` + `engine.mjs`). Padrão **desligado**; o usuário habilita em Configurações. O desinstalador remove a tarefa via hook NSIS.
2. **Backup** = `PRAGMA wal_checkpoint(TRUNCATE)` + cópia para `backups/manager-<timestamp>.sqlite`. Listagem e criação pela API e pela UI.
3. **Restauração é adiada**: a API grava `engine/restore.json`; no próximo boot, com o banco fechado, o Engine cria um backup `manager-pre-restore-*`, remove WAL/SHM antigos, copia o backup sobre o banco e apaga o marcador. Marcador inválido é descartado e o banco atual é preservado.
4. **Reinício do Engine** pelo shell (`restart_engine`): a UI para os projetos graciosamente, agenda o restore, mata a árvore do Engine e chama `ensure_engine`. No modo navegador, o usuário reinicia manualmente.
5. **Instalador NSIS por usuário** (`installMode: currentUser`, sem admin), com ícones e recursos do Engine. A desinstalação remove a tarefa de autostart e **preserva** `%LOCALAPPDATA%\LocalServerManager` e as pastas dos projetos.
6. **Upgrade**: o Engine só é substituído junto com o app; dados ficam fora do diretório de instalação; migrações têm backup automático; rollback = reinstalar a versão anterior.

**Alternativas consideradas:** serviço Windows (exige wrapper e privilégios; Fase 7); autostart por pasta Startup (menos controle/visibilidade); restore em quente (arriscado com conexões abertas).

**Consequências:** Sem admin, o app instala no perfil do usuário e o autostart ocorre no login (não antes dele). O restore exige reinício do Engine. O desinstalador não apaga dados sem ação manual.

## ADR-016 — Health check, portas e métricas

**Status:** Aceita (Fase 5)

**Contexto:** Processo ativo não significa aplicação saudável; conflito de porta e consumo de recursos precisam de diagnóstico sem comprometer o supervisor.

**Decisão:**

1. **Health check** roda em `HealthMonitor` próprio, independente do estado do processo:
   - HTTP (`GET`, status esperado) ou TCP (`host:porta`), com `timeoutMs`, `intervalMs` e `failureThreshold`;
   - saúde é `UNKNOWN`/`HEALTHY`/`UNHEALTHY` e nunca altera `status` por si só;
   - `restartOnUnhealthy` usa o restart controlado existente, com `unhealthyRestartCooldownMs` persistente entre ciclos para evitar loop;
   - monitor inicia em `RUNNING` e para no stop/exit; saúde volta a `UNKNOWN` no encerramento.
2. **Portas**:
   - disponibilidade por bind exclusivo em `127.0.0.1` (socket fechado imediatamente);
   - dono da porta via `netstat -ano -p tcp` (melhor esforço);
   - conflito **não bloqueia** o start e **não mata** o ocupante; gera `project.port.conflict`, log e `portInUse` no snapshot;
   - rotas `GET /ports` e `GET /ports/:port`.
3. **Métricas**:
   - amostragem em intervalo configurável (`metricsIntervalMs`, mínimo 1 s);
   - uma chamada PowerShell em lote (`Get-Process -Id ... | Select Id,CPU,WorkingSet64`);
   - CPU normalizada pelo total de núcleos, calculada por delta entre amostras (primeira amostra é `null`);
   - memória = `WorkingSet64`;
   - falha de leitura é não fatal e mantém a última amostra;
   - eventos `project.metrics`/`system.metrics`; **não** persistir métricas no SQLite;
   - `GET /system/metrics` retorna a última amostra (coleta se ainda não houver).

**Alternativas consideradas:** `pidusage` (depende de `wmic`, removido em versões recentes do Windows); persistir métricas em SQLite (volume alto, sem valor histórico nesta fase).

**Consequências:** diagnóstico operacional sem risco ao supervisor. CPU de processos protegidos pode vir `null`; o dono da porta pode não ser identificado sem privilégios. Health check consome uma requisição por intervalo por projeto — o padrão de 30 s evita ruído.

## ADR-015 — Interface desktop: SPA React + shell Tauri 2

**Status:** Aceita (Fase 4 concluída em 2026-11-07)

**Contexto:** O shell Tauri exige Rust/Cargo. A UI e o cliente foram entregues primeiro como SPA (Fase 4a) e validados no navegador; o shell nativo entrou na Fase 4b.

**Decisão:**

1. Interface como SPA React 19 + Vite 8 + Tailwind 4, em `apps/desktop`.
2. Estado do servidor com React Query; logs ao vivo em um buffer Zustand limitado a 2.000 linhas (histórico continua no HTTP/arquivo).
3. `HashRouter` para funcionar tanto no Vite quanto no protocolo customizado do Tauri.
4. Descoberta do Engine: no Tauri, o comando `ensure_engine` lê `engine.json`, testa TCP e sobe o Engine empacotado se preciso; no navegador, o Vite publica `/__engine`; `window.__LSM_ENGINE__` é fallback.
5. Componentes de UI próprios (Button, Card, Badge, Dialog, Field, Tabs) em vez do gerador shadcn/ui.
6. O desktop importa apenas `@lsm/contracts` (tipos puros). `@lsm/config` e `@lsm/shared` não entram no bundle do browser.
7. Eventos WebSocket atualizam o cache do React Query e o buffer de logs; reconexão invalida consultas; histórico mesclado por `sequence`.
8. Segredos de ambiente aparecem mascarados; o token da API nunca é renderizado.
9. Shell Tauri 2 (`apps/desktop/src-tauri`): Engine empacotado como recursos (`node.exe` + `engine.mjs`, copiados por `pnpm prepare:engine` e não versionados); spawn destacado com `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`; bandeja com "Abrir painel"/"Sair da interface"; fechar a janela minimiza para a bandeja e **não** encerra o Engine; CSP restrita a loopback; Engine já em execução é reutilizado e `engine.json` órfão é removido antes de subir outro.

**Alternativas consideradas:** Electron (descartado pelo ADR-003); sidecar via plugin shell (menos controle sobre ciclo de vida e logs); Node SEA (mais complexo que empacotar `node.exe`).

**Consequências:** desktop e navegador usam o mesmo cliente tipado. Instalador NSIS, assinatura e updater ficam na Fase 6. O pacote cresce ~93 MB por causa do `node.exe`.

## ADR-014 — API local HTTP + WebSocket para o desktop

**Status:** Aceita (Fase 3)

**Contexto:** O desktop precisa controlar o Engine sem `child_process` no renderer. A especificação prefere Named Pipe, mas aceita HTTP loopback autenticado como alternativa. Era preciso fechar transporte, autenticação, contrato de erro e estratégia de reconexão.

**Decisão:**

1. Transporte do MVP: HTTP em `127.0.0.1` com porta efêmera + WebSocket em `/api/v1/ws`. Named Pipe com ACL continua como evolução.
2. `engine/engine.json` publica `{ host, port, baseUrl, token, websocketPath, protocolVersion }`. O token (32 bytes, base64url) é gerado a cada execução e comparado com `timingSafeEqual`.
3. Defesas: bind exclusivo em loopback, validação de `Host` contra DNS rebinding, CORS por allowlist, corpo máximo de 1 MB, `nosniff`, `no-store`, sem stack trace na resposta.
4. Versão: `/api/v1` + `X-Protocol-Version` opcional; divergência → 409 `PROTOCOL_VERSION_MISMATCH`.
5. Envelope único (`OperationResult`) em todas as respostas; `requestId` vem de `X-Request-Id` ou é gerado.
6. WebSocket: snapshots sintéticos ao conectar, eventos ao vivo, heartbeat de 30 s, backpressure com descarte de `project.log` e aviso `engine.notice`/`LOG_BACKPRESSURE`. Reconexão usa o histórico HTTP como cursor.
7. Configuração do Engine persistida em `settings` (`engine.settings`): `batchConcurrency`, `logLevel`, `metricsIntervalMs`, `shutdownBehavior`. `keep-running` é rejeitado até existir logging desacoplado (processos ficariam sem supervisor e sem canal de log).
8. `PUT /projects/:id` é parcial (merge + validação completa); projeto em execução retorna `ENGINE_BUSY`.
9. `detect`/`import` são read-only quanto à pasta: leem `package.json`/lockfile e nunca executam script.
10. Adicionados: código `ROUTE_NOT_FOUND`, evento `engine.notice` e a lista `DOMAIN_EVENT_TYPES` no contrato.

**Alternativas consideradas:** Named Pipe já na Fase 3 (exigiria ACL nativa e complicaria testes); IPC via Tauri (acoplaria o Engine ao shell desktop).

**Consequências:** o mesmo cliente serve para o desktop, CLI e testes automatizados. O token em `engine.json` exige que o diretório de dados seja do usuário (já é `%LOCALAPPDATA%`); ACL explícita e Named Pipe entram na Fase 6/7.

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
