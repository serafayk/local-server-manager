# 06 — API interna e contratos

## 1. Princípios

- A API é privada e local.
- Toda operação mutável passa pelo Supervisor.
- Todas as respostas seguem envelope padronizado.
- Todos os eventos têm `eventId`, `timestamp` e `projectId` quando aplicável.
- Contratos compartilhados ficam em `packages/contracts`.
- Versionar protocolo para permitir evolução de UI e Engine.

## 2. Envelope de resposta

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

Não retornar stack trace ao frontend em produção. Stack trace completo fica no log interno.

## 3. Comandos

| Método | Rota                           | Finalidade                  |
| ------ | ------------------------------ | --------------------------- |
| GET    | `/api/v1/health`               | Saúde do Engine             |
| GET    | `/api/v1/projects`             | Listar projetos             |
| POST   | `/api/v1/projects`             | Criar projeto               |
| GET    | `/api/v1/projects/:id`         | Detalhar                    |
| PUT    | `/api/v1/projects/:id`         | Atualizar                   |
| DELETE | `/api/v1/projects/:id`         | Remover cadastro            |
| POST   | `/api/v1/projects/:id/start`   | Iniciar                     |
| POST   | `/api/v1/projects/:id/stop`    | Parar                       |
| POST   | `/api/v1/projects/:id/restart` | Reiniciar                   |
| GET    | `/api/v1/projects/:id/status`  | Estado atual                |
| GET    | `/api/v1/projects/:id/logs`    | Histórico de logs           |
| GET    | `/api/v1/projects/:id/events`  | Histórico de eventos        |
| POST   | `/api/v1/bulk/start`           | Iniciar selecionados        |
| POST   | `/api/v1/bulk/stop`            | Parar selecionados          |
| GET    | `/api/v1/system/metrics`       | Métricas globais            |
| GET    | `/api/v1/ports/:port`          | Consultar ocupação da porta |

A API pode usar métodos equivalentes em IPC, desde que os contratos permaneçam iguais.

## 4. Eventos WebSocket

Tipos iniciais:

- `engine.ready`
- `engine.shutdown`
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

## 5. Códigos de erro

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

Adicionados na implementação (ADR-010):

- `EXECUTABLE_REQUIRES_SHELL` — `.cmd`/`.bat` sem entrypoint JS resolvível
- `PROJECT_NAME_IN_USE` — nome duplicado (comparação sem caixa)
- `INVALID_STATE_TRANSITION` — operação incompatível com o estado atual
- `STORAGE_ERROR` — falha de banco/migração/JSON corrompido
- `PROTOCOL_VERSION_MISMATCH` — cliente com protocolo incompatível (Fase 3)
- `UNSUPPORTED_PLATFORM` — adaptador indisponível
- `LOG_WRITE_FAILED` — falha de gravação de log (não fatal)

O mapeamento código → status HTTP está em `packages/contracts/src/errors.ts`.

## 6. Operações em lote

Resposta deve conter sucesso/erro por projeto. Uma falha não cancela automaticamente os demais projetos, exceto se o usuário selecionar explicitamente modo transacional futuro.

## 7. Logs via WebSocket

Não transmitir arquivo inteiro em cada atualização. Enviar novas linhas/chunks com:

- projectId;
- instanceId;
- stream (`stdout`, `stderr`, `system`);
- timestamp;
- text;
- sequence.

Implementar limite de tamanho, controle de fluxo e possibilidade de reconectar pedindo cursor/sequence.
