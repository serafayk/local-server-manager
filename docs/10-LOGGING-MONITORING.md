# 10 — Logs, métricas e observabilidade

## 1. Streams

Cada processo pode produzir:

- `stdout`;
- `stderr`;
- eventos do sistema.

Os chunks de stream não são necessariamente linhas completas. Implementar decoder e buffer de linha com limite máximo para evitar crescimento infinito.

## 2. Formato de log

Campos internos:

- timestamp ISO 8601;
- projectId;
- instanceId;
- stream;
- sequence;
- text.

Formato de arquivo pode ser JSONL para processamento ou texto estruturado para leitura humana. Escolher um formato e documentar.

## 3. Diretórios

```text
%LOCALAPPDATA%/LocalServerManager/
  data/manager.sqlite
  logs/
    <project-id>/
      <instance-id>.log
  backups/
  engine/
```

## 4. Rotação

Configuração inicial sugerida:

- 10 MB por arquivo;
- retenção de 7 dias;
- limite global configurável;
- limpeza executada em background.

Os valores devem ser configuráveis. Nunca remover log que está sendo escrito sem sincronização.

## 5. Backpressure

Se a UI não acompanhar a velocidade de logs:

- manter gravação em disco;
- limitar buffer de memória;
- descartar apenas eventos de UI antigos quando necessário;
- informar que houve perda de linhas na visualização;
- permitir consultar arquivo/histórico.

## 6. Métricas

Coletar em intervalo configurável:

- CPU do processo/árvore quando disponível;
- memória RSS;
- PID;
- uptime;
- reinicializações;
- última saída;
- status do health check.

Não coletar a cada poucos milissegundos. Métricas são aproximadas e não devem afetar a estabilidade do Engine.

## 7. Eventos importantes

- projeto criado/alterado/removido;
- start solicitado;
- processo criado;
- processo encerrado;
- crash detectado;
- retry agendado;
- retry iniciado;
- health check falhou/recuperou;
- porta ocupada;
- Engine iniciou/encerrou;
- erro de persistência.

## 8. Privacidade

Logs podem conter tokens, senhas, dados de conexão e informações pessoais. Oferecer filtros de mascaramento para padrões comuns, avisar que mascaramento heurístico não é garantia e permitir desativar captura de logs por projeto.
