# Changelog

Todas as mudanças relevantes do projeto. Formato inspirado em Keep a Changelog.

## [0.16.0] — 2026-11-09

### Fase 15 — Painel web e acesso sem o app

- UI servida pelo Engine no mesmo endereço da API (porta fixa **4317**, fallback automático), com assets copiados para `resources/engine/web` no build.
- Senha definida no primeiro acesso (scrypt), sessão por cookie `HttpOnly`/`SameSite=Strict` de 12h e **CSRF** por sessão em métodos de escrita.
- Rate limit de 5 logins/min, CSP restritiva e bind exclusivo em 127.0.0.1.
- `GET/POST /auth/status|setup|login|logout`; Bearer token do desktop continua válido.
- WebSocket aceita cookie, então logs/eventos ao vivo funcionam na web.
- Botão **Abrir no navegador** em Configurações.
- 2 novos testes de integração; total de 355.

## [0.15.1] — 2026-11-09

### Parada graciosa por projeto

- `stopCommand` (`executable` + `args`) opcional, executado antes de encerrar o processo, com timeout de 30s; falhas são registradas sem impedir a parada.
- Migração v7 (`stop_command_json`), validação, export/import e campo no cadastro.
- Caso de uso: robô PHP (`php bin\robot --config=... --stop`) soltando o lease antes do kill.
- 2 novos testes; total de 353.

## [0.15.0] — 2026-11-09

### Fase 14 — Serviços além de Node

- `kind` (`node`/`process`/`compose`/`postgres`) com configuração específica; migração v6 (`kind`, `compose_json`, `postgres_json`).
- **Docker Compose**: `docker compose up` anexado com logs e crash no supervisor; `down --remove-orphans` ao parar; executável e arquivo configuráveis.
- **PostgreSQL dedicado**: data dir próprio, `initdb` automático e instância como **serviço do Windows** (NetworkService) — necessário porque `postgres.exe` recusa token de administrador (UAC desabilitado). Start/stop via `sc`, monitor de estado e logs de `postgresql.log`.
- **Backup**: `POST /projects/:id/backup` gera `.dump` com `pg_dump`.
- **Detecção**: `GET /system/tools` lista PostgreSQL instalado e estado do Docker; nenhum download automático.
- Excluir projeto remove o serviço e preserva o data dir.
- UI: tipo no cadastro com painéis de Compose/Postgres, conexão + backup no detalhe.
- 18 novos testes; total de 351.

## [0.14.0] — 2026-11-08

### Fase 13 — Domínios locais

- Proxy reverso do Engine em `127.0.0.1:8090` (HTTP) e `:8443` (HTTPS), com fallback automático de porta e preferência persistida.
- Tabela `domains` (migração v5): host único → projeto, com porta opcional.
- `.lsm` (arquivo hosts) e `.localhost` (sem configuração); o alias `.localhost` de uma rota `.lsm` já funciona antes do UAC.
- Bloco gerenciado no arquivo hosts com sincronização em lote (um único prompt de UAC) e remoção de domínios órfãos.
- CA local no `CurrentUser\Root` e certificado por host sob demanda (SAN com domínio e alias); confiança na CA é ação explícita.
- Roteamento por `Host` com 404/502 explicativos; `Host`/`Origin` reescritos para `127.0.0.1:<porta>`, original em `x-forwarded-*`.
- WebSocket/HMR encaminhados por upgrade TCP.
- Página **Domínios** com URLs (HTTP/HTTPS/.localhost), copiar/abrir, status do proxy/CA/hosts e CRUD.
- Comando `open_url` no shell (abre o navegador padrão) e 22 novos testes; total de 332.

## [0.13.0] — 2026-11-08

### Fase 12 — Stacks com dependências

- `dependsOn` (`{ projectId, waitFor }`) e `dependencyTimeoutMs` por projeto; migração v4 (`depends_on_json`, `dependency_timeout_ms`).
- `waitFor`: `ready` aguarda health check saudável (ou processo iniciado quando não há health check); `started` aguarda o processo.
- `StackService` resolve dependências transitivas e sobe em níveis topológicos, em paralelo dentro do nível.
- Start individual e `bulk/start` sobem a cadeia necessária; stop de grupo acontece na ordem inversa e não derruba dependências externas.
- Falha de dependência propaga `DEPENDENCY_FAILED` sem iniciar o dependente.
- Ciclos, auto-dependência e referências inexistentes são rejeitados; remover projeto com dependentes exige `force` e desvincula automaticamente.
- Exportação referencia dependências por nome; importação reconecta em segunda passada.
- UI: seleção de dependências com critério e timeout no cadastro, botões Subir stack/Parar/Reiniciar em Grupos e vínculos no detalhe do projeto.
- 12 novos testes; total de 310.

## [0.12.0] — 2026-11-08

### Fase 11 — Execução direta e hospedagem estática

- `launchMode` (`auto`/`wrapper`/`direct`): resolve o script para `node`, `node --import tsx`, `next` ou `vite`, eliminando pnpm, cmd.exe e o CLI intermediário (~100 MB por projeto).
- `GET /projects/:id/launch-preview` mostra comando, motivo e processos evitados; scripts com shell ou `tsx watch` em `auto` caem no wrapper.
- `serveMode: static`: o Engine serve `dist`/`build`/`out` no próprio processo, com SPA fallback, MIME, cache e proteção contra path traversal — projeto `RUNNING` sem PID.
- `POST /projects/:id/build`: build one-shot com logs e timeout de 15 min.
- Migração v3 (`launch_mode`, `serve_mode`, `output_dir`), campos na API/UI e export/import.
- 10 novos testes; total de 297.

## [0.11.1] — 2026-11-08

### Instalação sobre um Engine em execução

- Hook `NSIS_HOOK_PREINSTALL` encerra o app e o Engine (incluindo os processos gerenciados)
  antes de copiar arquivos, liberando `resources\engine\node.exe`.
- O mesmo encerramento foi adicionado ao `PREUNINSTALL`.
- Novo comando Tauri `stop_engine` e botão **Configurações → Engine → Encerrar Engine**.
- Guia do usuário documenta atualização sem desinstalar e preservação de dados.

## [0.11.0] — 2026-11-08

### Fase 10 — Túneis Cloudflare supervisionados

- Nova entidade `tunnels` (migração v2) com modos **config.yml**, **token** e **quick tunnel**.
- Start/stop/restart independentes, `start_on_boot`, logs JSONL (`tunnel.log`) e health via `/ready`.
- Hostnames lidos do `ingress` do config.yml; URL do quick tunnel extraída da saída.
- Token por `TUNNEL_TOKEN`, nunca em argv/log e exposto apenas como `hasToken`.
- Portas de métricas 20241–20260 e guarda contra instâncias duplicadas do mesmo túnel/porta.
- API `/api/v1/tunnels` (CRUD + start/stop/restart/logs) e página **Túneis** no desktop.
- 11 novos testes; total de 287.

## [0.10.0] — 2026-11-08

### Fase 9 — Memória por projeto e perfis

- Métricas passam a somar a **árvore de processos** (`Win32_Process`): working set,
  memória privada, CPU e contagem por projeto (pnpm → tsx/node/next). `conhost`,
  `werfault`, `openconsole` e `runtimebroker` são ignorados.
- `ProjectMetricsPayload` ganha `privateBytes`, `processCount` e `processes[]`.
- UI: coluna **Memória** na lista (com nº de processos), cartões de memória privada
  e processos, e tabela por processo no detalhe.
- **Perfis de memória** (Baixo/Médio/Alto/Personalizado) aplicam `NODE_OPTIONS` no
  projeto; seletor também no "Adicionar pela raiz".
- 8 novos testes; total de 276.
- Skill global do OpenCode `local-server-manager` (fora do repositório) para
  orientar agentes a cadastrar/iniciar projetos Node pelo LSM.

## [0.9.0] — 2026-11-08

### Fase 8 — Configuração assistida e fim do loop de reinício

- **Adicionar pela raiz**: `POST /api/v1/projects/scan-root` reconhece workspaces (pnpm/npm/yarn/turbo/lerna), portas (`.env`, `*.config.ts`, `-p/--port` no script), health (`/health`) e sugere grupo. Somente leitura.
- Tela de revisão com checkbox, nome, script, porta e health editáveis; portas repetidas bloqueiam a criação; apps Expo/React Native vêm desmarcados.
- **Seletor de pasta nativo** (`pick_folder`, FolderBrowserDialog) no cadastro e na varredura; campo de texto permanece como alternativa.
- **Editar na lista de projetos**, com "Parar e editar" quando o processo está ativo; **Duplicar** reaproveitando o formulário (sem porta/boot).
- Formulário: campos avançados (retry, timeouts, health) recolhidos; removido campo Grupo duplicado; dica sobre `start` vs `dev` e build prévio.
- **Falhas fatais abortam o retry**: `EADDRINUSE`, build ausente, módulo ausente, `ECONNREFUSED` e `EACCES` → status **FALHOU**, `lastFailureHint` no snapshot e evento `project.recovery.aborted`, em vez de ciclo infinito.
- 5 novos testes (scanner, rota e abort de retry); total de 268.

## [0.8.0] — 2026-11-08

### Fase 7 (parcial) — Melhorias

- Grupos: CRUD completo na API/UI, filtro de projetos, campo no cadastro e start/stop em lote por grupo; excluir o grupo mantém os projetos.
- Exportação de configurações em JSON sem IDs internos e sem valores de variáveis sensíveis (`maskedEnvironmentKeys`).
- Importação validada por schema, com recriação de grupos por nome e resultado por projeto (conflito de nome não cancela os demais).
- Detecção de instalações de Node (NVM for Windows, sistema e Engine) e seleção no cadastro.
- API: `/groups`, `/projects/export`, `/projects/import-config`, `/system/node-versions`.
- 12 novos testes; total de 263.

### Backlog da Fase 7

- Dependências reais entre projetos, perfis de configuração, Named Pipe/Job Objects, assinatura de código e updater automático.

## [0.7.0] — 2026-11-08

### Fase 6 — Distribuição e operação no Windows

- Autostart via Agendador de Tarefas (`ONLOGON`, `LIMITED`, sem admin), com toggle em Configurações e status real.
- Desinstalador remove a tarefa de autostart via hook NSIS e preserva `%LOCALAPPDATA%` e pastas dos projetos.
- Backup do SQLite com checkpoint do WAL, listagem e criação pela API/UI.
- Restauração adiada para o próximo boot (marcador + backup pré-restore), com reinício automático do Engine no app Tauri.
- Comandos Tauri `autostart_status`, `set_autostart` e `restart_engine`; testes unitários do comando de tarefa e do parser de PID.
- Instalador NSIS por usuário (`installMode: currentUser`) com recursos do Engine.
- Guia do usuário (`docs/16-USER-GUIDE.md`).
- 6 novos testes JS; total de 251. `cargo test` 2/2.

### Limitações desta versão

- Assinatura de código e updater automático ficam para a Fase 7.

## [0.6.0] — 2026-11-08

### Fase 5 — Monitoramento

- Health check HTTP/TCP por projeto, independente do estado do processo, com `intervalMs`, `timeoutMs`, `failureThreshold` e `expectedStatus`.
- Saúde `UNKNOWN/HEALTHY/UNHEALTHY` com transições por threshold e recuperação; evento `project.health.changed` com detalhe.
- `restartOnUnhealthy` usa o restart controlado com cooldown persistente entre ciclos.
- Detecção de conflito de porta no start por bind exclusivo em loopback, dono via `netstat` (best-effort), evento `project.port.conflict` e `portInUse` no snapshot — sem bloquear nem matar o ocupante.
- Métricas de CPU/memória em lote via PowerShell (`Get-Process`), CPU normalizada por núcleo com delta entre amostras e `null` na primeira leitura.
- Eventos `project.metrics`/`system.metrics`; intervalo configurável (mín. 1 s) e coleta não fatal.
- API: `GET /system/metrics`, `GET /ports`, `GET /ports/:port`.
- UI: cartões de CPU/RAM no Dashboard, alerta de porta em uso na tabela, aba Métricas do projeto com dados ao vivo e nota de saúde nos detalhes.
- 32 novos testes; total de 245.

### Limitações desta versão

- CPU/memória e dono da porta são melhor esforço; instalador/updater ficam na Fase 6.

## [0.5.0] — 2026-11-07

### Fase 4b — Shell Tauri 2

- `apps/desktop/src-tauri` com Tauri 2, janela nativa, tema escuro e CSP restrita a loopback + IPC.
- Engine empacotado como recurso (`node.exe` + bundle `engine.mjs`), preparado por `pnpm prepare:engine` e ignorado pelo git.
- Comando `ensure_engine`: reutiliza Engine em execução, remove `engine.json` órfão e sobe o Engine embarcado aguardando até 20 s.
- Spawn destacado (`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`): fechar a interface não encerra o Engine nem os projetos.
- Bandeja com "Abrir painel" e "Sair da interface"; fechar a janela minimiza para a bandeja.
- Descoberta no frontend prioriza o comando Tauri, com fallback para `/__engine` (dev) e `window.__LSM_ENGINE__`.
- Ícones gerados (`32x32`, `128x128`, `128x128@2x`, `icon.ico`).
- Scripts `tauri:dev` e `tauri:build`; documentação de toolchain e operação.
- Correções da validação real: normalização de caminhos verbatim (`\\?\`) ao iniciar o Engine e exclusão de `src-tauri/target` do watcher do Vite.
- Validado no executável de release: Engine embarcado sobe, `/health` responde e o processo **sobrevive** ao fechamento do app.

### Limitações desta versão

- Instalador assinado, updater e desinstalação guiada ficam na Fase 6.
- Health check, portas e métricas continuam na Fase 5.

## [0.4.0] — 2026-11-07

### Fase 4a — Interface desktop (SPA)

- App React 19 + Vite 8 + Tailwind 4 em `apps/desktop`, tema escuro e layout com sidebar.
- Cliente tipado da API com envelope, `ApiError` estável e autenticação por token.
- Descoberta do Engine em desenvolvimento via `/__engine` (Vite lê `engine.json`); produção prevista via `window.__LSM_ENGINE__` (shell Tauri).
- WebSocket com reconexão exponencial; eventos atualizam o React Query e o buffer de logs.
- Dashboard com indicadores, tabela de projetos e ações rápidas.
- Projetos com busca, filtro por estado, seleção múltipla, start/stop em lote e remoção confirmada.
- Cadastro em 3 etapas (Projeto → Comando → Execução) com detecção de `package.json`/lockfile, ambiente, porta, políticas e revisão do comando.
- Detalhes com abas Visão geral, Logs, Configuração, Histórico e Métricas (reservada).
- Logs virtualizados mergendo histórico HTTP + fluxo ao vivo por `sequence`, com filtros e auto-scroll.
- Eventos com filtros por projeto, nível e limite.
- Configurações do Engine (concorrência, log level, métricas) com nota sobre `shutdownBehavior`.
- Estados explícitos de conexão/carregamento/vazio/erro; ações destrutivas com confirmação; segredos mascarados.
- Rota `GET /projects/:id/instances` e suporte a políticas no `POST /projects/import`.
- 39 novos testes de UI (componentes, cliente, formulário, logs, store); total de 213.

### Limitações desta versão

- Shell Tauri (`src-tauri`) pendente por ausência de Rust/Cargo; tray, janela nativa e sidecar ficam para a Fase 4b.

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
