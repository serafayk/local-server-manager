# 03 — Engine e módulos internos

## 1. Objetivo

O Engine é um processo Node.js de longa duração que mantém os projetos sob supervisão. Ele não é um servidor web de negócio; é o plano de controle local do aplicativo.

## 2. Módulos

```text
apps/engine/src/
  bootstrap/
    main.ts
    single-instance.ts
    shutdown.ts
  core/
    event-bus.ts
    operation-result.ts
    clock.ts
    logger.ts
  api/
    server.ts
    routes/
    auth/
    websocket/
  supervisor/
    supervisor.ts
    project-runtime.ts
    runtime-registry.ts
    operation-queue.ts
  process-manager/
    process-manager.ts
    spawn-adapter.ts
    windows-process-tree.ts
    executable-resolver.ts
  recovery/
    recovery-manager.ts
    backoff-policy.ts
    retry-budget.ts
  health-monitor/
    health-monitor.ts
    http-probe.ts
    tcp-probe.ts
  log-manager/
    log-manager.ts
    log-writer.ts
    log-rotation.ts
  metrics/
    metrics-collector.ts
    process-metrics.ts
  scheduler/
    startup-projects.ts
    dependency-order.ts
  persistence/
    project-repository.ts
    runtime-repository.ts
    event-repository.ts
```

## 3. Supervisor

O Supervisor coordena cada `ProjectRuntime`. Deve expor métodos de domínio:

- `registerProject(config)`
- `startProject(projectId, reason)`
- `stopProject(projectId, reason)`
- `restartProject(projectId, reason)`
- `startProjects(projectIds)`
- `stopProjects(projectIds)`
- `getProjectStatus(projectId)`
- `shutdown()`

Não permitir que rotas HTTP manipulem diretamente processos. As rotas chamam o Supervisor.

## 4. ProjectRuntime

Uma instância em memória por projeto cadastrado:

- configuração normalizada;
- estado atual;
- PID e identificador da instância;
- timestamps;
- contador de falhas;
- tentativa de restart;
- estado de health check;
- referência ao processo filho;
- fila de operações.

Não persistir objetos `ChildProcess` no banco.

## 5. Process Manager

Responsável por:

- resolver executável;
- construir `spawn(executable, args, options)`;
- configurar `cwd` e `env`;
- capturar stdout/stderr;
- capturar `error`, `spawn`, `exit` e `close`;
- encerrar processo e descendentes;
- informar exit code e signal.

Configuração recomendada:

- `shell: false`;
- `windowsHide: true`;
- `stdio: ['ignore', 'pipe', 'pipe']`;
- `cwd` validado;
- ambiente derivado de `process.env` mais overrides do projeto.

Não concatenar comando e argumentos em uma string para executar no shell.

## 6. Recovery Manager

Recebe eventos de encerramento inesperado e consulta política. Deve aplicar:

- retry limit;
- exponential backoff;
- jitter opcional;
- cooldown após estabilidade;
- reset de contador após tempo saudável;
- proteção contra loops;
- distinção entre falha de spawn e crash.

Não reiniciar em caso de parada manual ou shutdown planejado.

## 7. Health Monitor

Executa probes independentes:

- HTTP GET/HEAD com timeout e status esperado configurável;
- TCP connect;
- intervalo configurável;
- limiar de falhas consecutivas;
- janela de recuperação.

O monitor não deve marcar `RUNNING` como `STOPPED` só porque o endpoint falhou. Estado do processo e estado de saúde são dimensões separadas. O status de apresentação pode ser `RUNNING_UNHEALTHY`.

## 8. Log Manager

Captura chunks de stdout/stderr sem assumir que cada chunk é uma linha completa. Deve montar linhas preservando fragmentos e limitar buffers.

Escreve arquivos por projeto e instância, com rotação por tamanho/tempo e retenção. Emite eventos de log para a UI com limite de tamanho e backpressure.

## 9. Metrics Collector

Coleta métricas em intervalo moderado e independente de health check. Falha na métrica é não fatal. CPU e memória devem indicar escopo: processo principal ou árvore de processos, conforme suporte disponível.

## 10. Shutdown do Engine

No encerramento:

1. parar de aceitar novos comandos;
2. persistir intenção de shutdown;
3. cancelar health checks e retries pendentes;
4. conforme configuração, deixar projetos rodando ou pará-los;
5. liberar handles e conexão do banco;
6. registrar encerramento.

A configuração padrão recomendada é **deixar projetos rodando quando a interface fecha**, mas em encerramento do Engine o comportamento deve ser explícito e configurável. O Engine não deve encerrar projetos silenciosamente ao receber uma atualização ou reiniciar.
