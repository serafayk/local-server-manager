# 12 — Roadmap de implementação

## Status (2026-11-07)

- **Fase 0 — concluída:** monorepo pnpm, TypeScript strict, ESLint/Prettier, Vitest, contratos, validação, configuração, banco, adaptadores Windows e CI.
- **Fase 1 — concluída:** bootstrap do Engine, instância única, SQLite + migrações, cadastro/listagem/remoção, `spawn` sem shell, supervisor com máquina de estados, logs JSONL e CLI de desenvolvimento.
- **Fase 2 — concluída:** recovery com backoff/retry budget/cooldown de estabilidade, reconciliação segura de órfãos no boot, bloqueio de `startOnBoot` com órfão comprovado e retenção de logs.
- **Fase 3 — concluída:** API HTTP local autenticada, rotas de projetos/lote/logs/eventos/settings, `detect`/`import` de pasta, WebSocket com snapshots, heartbeat e backpressure, protocolo versionado.
- **Fase 4 — concluída:** UI completa (dashboard, projetos, cadastro em 3 etapas, detalhes, logs ao vivo, eventos, configurações) + shell Tauri 2 com bandeja, close-to-tray e Engine empacotado como recurso.
- **Fase 5 — concluída:** health check HTTP/TCP com threshold e restart opcional com cooldown, detecção de conflito de porta (sem matar o ocupante) e métricas de CPU/memória via PowerShell em lote, expostas na UI.
- **Fase 6 — concluída:** autostart via Agendador de Tarefas (toggle no app, remoção no desinstalador), backup/restauração do SQLite com aplicação no boot, instalador NSIS por usuário e documentação do usuário.
- **Próxima:** Fase 7 (melhorias: grupos/dependências, import/export, múltiplas versões de Node, perfis, Named Pipe/Job Objects).

Detalhes de execução, comandos e limitações: [15-DEVELOPMENT.md](15-DEVELOPMENT.md), [16-USER-GUIDE.md](16-USER-GUIDE.md) e `CHANGELOG.md`.

## Fase 0 — Fundação

- criar monorepo pnpm;
- configurar TypeScript estrito;
- ESLint/Prettier;
- Vitest;
- contracts e validação;
- CI local e scripts de desenvolvimento.

**Saída:** workspace compila e testes rodam.

## Fase 1 — Engine mínimo

- bootstrap;
- single instance;
- SQLite e migrações;
- cadastro/listagem de projetos;
- Process Manager;
- Supervisor;
- start/stop/restart;
- logs básicos.

**Saída:** controlar processos via testes/CLI, sem UI.

## Fase 2 — Resiliência

- estados completos;
- restart policy;
- backoff;
- proteção de concorrência;
- árvore de processos Windows;
- recuperação e reconciliação;
- testes de crash.

**Saída:** Engine confiável para uso contínuo.

## Fase 3 — API e comunicação

- transporte local;
- autenticação;
- endpoints;
- WebSocket;
- reconexão;
- contratos versionados.

**Saída:** cliente externo de teste controla Engine.

## Fase 4 — Desktop MVP

- Tauri + React;
- dashboard;
- cadastro;
- lista e detalhes;
- ações individuais e em lote;
- logs em tempo real;
- tray.

**Saída:** aplicativo utilizável.

## Fase 5 — Monitoramento

- health check HTTP/TCP;
- portas;
- métricas;
- histórico de eventos;
- alertas visuais.

**Saída:** diagnóstico operacional.

## Fase 6 — Windows e distribuição

- tarefa de inicialização;
- instalador;
- atualização;
- desinstalação;
- backup e restauração;
- documentação do usuário.

**Saída:** pacote instalável.

## Fase 7 — Melhorias

- grupos e dependências;
- importação/exportação;
- múltiplas versões Node;
- filtros avançados;
- perfis de configuração.

## Regra de execução

Não avançar de fase se a fase atual não compilar, não tiver testes mínimos ou tiver bugs críticos conhecidos. Manter changelog e atualizar documentos quando decisões mudarem.
