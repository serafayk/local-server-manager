# 06 — API interna e contratos

> **Status:** implementada na Fase 3 (ADR-014). Transporte HTTP em `127.0.0.1`
> com porta dinâmica e token por execução; WebSocket para eventos.

## 1. Princípios

- A API é privada e local, com bind apenas em `127.0.0.1`.
- Toda operação mutável passa pelo Supervisor.
- Todas as respostas seguem envelope padronizado.
- Todos os eventos têm `eventId`, `timestamp` e `projectId` quando aplicável.
- Contratos compartilhados ficam em `packages/contracts`.
- Versionar protocolo para permitir evolução de UI e Engine.

## 2. Transporte, descoberta e autenticação

- O Engine escuta em porta efêmera (`127.0.0.1:0`).
- Ao iniciar, grava `engine/engine.json` com `pid`, `protocolVersion`,
  `dataDir`, `startedAt`, `projects` e `api: { host, port, baseUrl, token, websocketPath }`.
- O token tem 32 bytes aleatórios por execução e é comparado em tempo constante.
- Rotas HTTP exigem `Authorization: Bearer <token>`.
- WebSocket aceita token por query (`/api/v1/ws?token=...`) ou header.
- `Host` precisa ser loopback na porta real (proteção contra DNS rebinding).
- `Origin` é validado por allowlist (Vite `localhost:1420`, `tauri://localhost`,
  `http://tauri.localhost`); requisições sem `Origin` são aceitas (CLI/curl).
- Limite de corpo: 1 MB. `x-content-type-options: nosniff` e `cache-control: no-store`.
- Versão do protocolo: `/api/v1` + header opcional `X-Protocol-Version`.
  Divergência retorna 409 `PROTOCOL_VERSION_MISMATCH`.

## 3. Envelope de resposta

```ts
export type OperationResult<T> =
  | { success: true; data: T; requestId: string; timestamp: string }
  | {
      success: false;
      error: { code: string; message: string; details?: unknown };
      requestId: string;
      timestamp: string;
    };
```

`requestId` vem de `X-Request-Id` quando presente (até 128 caracteres) ou é
gerado pelo Engine. Não retornar stack trace; o stack completo fica no log interno.

## 4. Rotas

| Método | Rota                                  | Finalidade                                              |
| ------ | ------------------------------------- | ------------------------------------------------------- |
| GET    | `/api/v1/health`                      | Saúde do Engine                                         |
| GET    | `/api/v1/auth/status`                 | Senha configurada / sessão atual (público)              |
| POST   | `/api/v1/auth/setup`                  | Define a senha no primeiro acesso                       |
| POST   | `/api/v1/auth/login`                  | Cria sessão por cookie                                  |
| POST   | `/api/v1/auth/logout`                 | Encerra a sessão                                        |
| GET    | `/api/v1/info`                        | Informações + endpoint da API                           |
| GET    | `/api/v1/projects`                    | Listar projetos (com runtime)                           |
| POST   | `/api/v1/projects`                    | Criar projeto                                           |
| POST   | `/api/v1/projects/detect`             | Ler `package.json`/lockfile                             |
| POST   | `/api/v1/projects/scan-root`          | Varrer a raiz e propor projetos                         |
| POST   | `/api/v1/projects/import`             | Criar a partir de uma pasta                             |
| GET    | `/api/v1/projects/export`             | Exportar configurações (sem segredos)                   |
| POST   | `/api/v1/projects/import-config`      | Importar bundle de configurações                        |
| GET    | `/api/v1/groups`                      | Listar grupos                                           |
| POST   | `/api/v1/groups`                      | Criar grupo                                             |
| PUT    | `/api/v1/groups/:id`                  | Renomear/reordenar grupo                                |
| DELETE | `/api/v1/groups/:id`                  | Remover grupo                                           |
| POST   | `/api/v1/groups/:id/start`            | Subir stack na ordem topológica                         |
| POST   | `/api/v1/groups/:id/stop`             | Parar dependentes antes das dependências                |
| POST   | `/api/v1/groups/:id/restart`          | Reiniciar a stack                                       |
| GET    | `/api/v1/domains`                     | Rotas + status do proxy/CA/hosts                        |
| POST   | `/api/v1/domains`                     | Criar rota (`host`, `projectId`, `port?`)               |
| PUT    | `/api/v1/domains/:id`                 | Alterar host/porta                                      |
| DELETE | `/api/v1/domains/:id`                 | Remover rota                                            |
| POST   | `/api/v1/domains/hosts/sync`          | Gravar bloco no hosts (UAC, em lote)                    |
| POST   | `/api/v1/domains/ca/trust`            | Confiar na CA local (CurrentUser)                       |
| GET    | `/api/v1/domains/ca`                  | Certificado da CA em PEM                                |
| GET    | `/api/v1/system/tools`                | PostgreSQL instalado + estado do Docker                 |
| GET    | `/api/v1/projects/:id/postgres`       | Conexão do Postgres dedicado                            |
| POST   | `/api/v1/projects/:id/backup`         | `pg_dump` do banco padrão                               |
| GET    | `/api/v1/system/node-versions`        | Instalações de Node detectadas                          |
| GET    | `/api/v1/tunnels`                     | Lista túneis Cloudflare                                 |
| POST   | `/api/v1/tunnels`                     | Cria túnel (config/token/quick)                         |
| GET    | `/api/v1/tunnels/:id`                 | Detalhe do túnel                                        |
| PUT    | `/api/v1/tunnels/:id`                 | Atualiza (parado)                                       |
| DELETE | `/api/v1/tunnels/:id`                 | Remove cadastro                                         |
| POST   | `/api/v1/tunnels/:id/start`           | Inicia cloudflared                                      |
| POST   | `/api/v1/tunnels/:id/stop`            | Para                                                    |
| POST   | `/api/v1/tunnels/:id/restart`         | Reinicia                                                |
| GET    | `/api/v1/tunnels/:id/logs`            | Saída do cloudflared                                    |
| GET    | `/api/v1/projects/:id`                | Detalhar                                                |
| PUT    | `/api/v1/projects/:id`                | Atualizar (parcial, mesclado)                           |
| DELETE | `/api/v1/projects/:id`                | Remover cadastro (`?force=true` desvincula dependentes) |
| POST   | `/api/v1/projects/:id/start`          | Iniciar (sobe dependências antes)                       |
| POST   | `/api/v1/projects/:id/stop`           | Parar                                                   |
| POST   | `/api/v1/projects/:id/restart`        | Reiniciar                                               |
| GET    | `/api/v1/projects/:id/launch-preview` | Comando resolvido (direto/wrapper)                      |
| POST   | `/api/v1/projects/:id/build`          | Rodar o script `build` uma vez                          |
| GET    | `/api/v1/projects/:id/status`         | Estado atual                                            |
| GET    | `/api/v1/projects/:id/logs`           | Histórico de logs (`?tail`, `?instanceId`)              |
| GET    | `/api/v1/projects/:id/events`         | Histórico de eventos                                    |
| GET    | `/api/v1/projects/:id/instances`      | Histórico de instâncias                                 |
| GET    | `/api/v1/events`                      | Histórico global (`?projectId`)                         |
| POST   | `/api/v1/bulk/start`                  | Iniciar selecionados (ordem topológica)                 |
| POST   | `/api/v1/bulk/stop`                   | Parar selecionados (ordem inversa)                      |
| GET    | `/api/v1/settings`                    | Configuração do Engine                                  |
| PUT    | `/api/v1/settings`                    | Atualiza configuração                                   |
| GET    | `/api/v1/ws`                          | WebSocket de eventos                                    |
| GET    | `/api/v1/system/metrics`              | Métricas atuais dos processos                           |
| POST   | `/api/v1/system/backup`               | Cria backup do SQLite                                   |
| GET    | `/api/v1/system/backups`              | Lista backups disponíveis                               |
| POST   | `/api/v1/system/restore`              | Agenda restauração para o próximo boot                  |
| GET    | `/api/v1/ports`                       | Ocupação das portas configuradas                        |
| GET    | `/api/v1/ports/:port`                 | Ocupação de uma porta                                   |

`PUT /projects/:id` é uma atualização parcial: campos ausentes preservam o
valor atual e o resultado passa pela validação completa. Projeto em execução
não pode ser editado (`ENGINE_BUSY`).

`POST /projects/detect` e `/import` não executam scripts nem instalam nada.
`import` aceita `script` (resolvido sem shell via package manager) ou
`executable` + `args` explícitos.

## 5. Eventos WebSocket

Tipos:

- `engine.ready`
- `engine.shutdown`
- `engine.notice` (avisos: backpressure, reconciliação, etc.)
- `project.created`
- `project.updated`
- `project.deleted`
- `project.state.changed`
- `project.process.started`
- `project.process.exited`
- `project.crashed`
- `project.restart.scheduled`
- `project.restart.started`
- `project.recovery.exhausted`
- `project.health.changed`
- `project.port.conflict`
- `project.log`
- `project.metrics`
- `system.metrics`

Exemplo:

```ts
interface DomainEvent<T> {
  eventId: string;
  protocolVersion: 1;
  type: string;
  timestamp: string;
  projectId?: string;
  payload: T;
}
```

Ao conectar, o servidor envia um `project.state.changed` sintético por projeto
(snapshot atual), seguido do fluxo ao vivo. Heartbeat de 30 s com
`ping`/`pong`; conexões sem resposta são encerradas (1013).

## 6. Códigos de erro

- `PROJECT_NOT_FOUND`
- `PROJECT_INVALID_CONFIG`
- `PROJECT_ALREADY_RUNNING`
- `PROJECT_NOT_RUNNING`
- `PROJECT_START_FAILED`
- `PROJECT_STOP_TIMEOUT`
- `WORKING_DIRECTORY_NOT_FOUND`
- `EXECUTABLE_NOT_FOUND`
- `PORT_IN_USE`
- `ENGINE_BUSY`
- `UNAUTHORIZED`
- `VALIDATION_ERROR`
- `INTERNAL_ERROR`

Adicionados na implementação (ADR-010/ADR-014):

- `EXECUTABLE_REQUIRES_SHELL` — `.cmd`/`.bat` sem entrypoint JS resolvível
- `PROJECT_NAME_IN_USE` — nome duplicado (comparação sem caixa)
- `INVALID_STATE_TRANSITION` — operação incompatível com o estado atual
- `STORAGE_ERROR` — falha de banco/migração/JSON corrompido
- `PROTOCOL_VERSION_MISMATCH` — cliente com protocolo incompatível
- `UNSUPPORTED_PLATFORM` — adaptador indisponível
- `LOG_WRITE_FAILED` — falha de gravação de log (não fatal)
- `ROUTE_NOT_FOUND` — rota inexistente

O mapeamento código → status HTTP está em `packages/contracts/src/errors.ts`.

## 7. Operações em lote

A resposta contém sucesso/erro por projeto. Uma falha não cancela
automaticamente os demais.

## 8. Logs e reconexão

- Cada registro tem `projectId`, `instanceId`, `stream`, `timestamp`, `text`,
  `sequence` e `truncated`.
- O WebSocket entrega apenas o fluxo ao vivo.
- Ao reconectar, o cliente busca `GET /projects/:id/logs?tail=N` (ou
  `?instanceId=&tail=N`) e depois volta a consumir o WebSocket.
- Sob backpressure, eventos `project.log` são descartados para o cliente
  lento; um `engine.notice` com `code: "LOG_BACKPRESSURE"` informa o descarte
  e o histórico completo continua no arquivo/HTTP.
