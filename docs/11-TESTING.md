# 11 — Testes e critérios de aceite

## 1. Estratégia

- Unitários: políticas, validação, estados e backoff.
- Integração: spawn real de processos Node de teste.
- E2E: UI + Engine.
- Testes Windows: encerramento de árvore, paths, tarefa de inicialização e permissões.
- Testes de estresse: muitos processos e grande volume de logs.

## 2. Fixtures

Criar pequenos projetos de teste:

- servidor HTTP que responde `/health`;
- servidor que encerra após alguns segundos;
- processo que encerra com exit code diferente de zero;
- processo que ignora encerramento gracioso;
- worker sem HTTP;
- processo que gera stdout/stderr continuamente;
- processo com subprocesso filho;
- servidor que ocupa porta fixa;
- servidor que fica ativo mas deixa de responder.

Não usar projetos reais do usuário nos testes automatizados.

## 3. Casos obrigatórios

### Processo

- iniciar processo válido;
- executável inexistente;
- diretório inexistente;
- argumento com espaços;
- saída normal;
- crash inesperado;
- stop manual;
- restart manual;
- start concorrente duplicado;
- stop durante STARTING;
- Engine encerra enquanto projeto roda.

### Recovery

- restart habilitado;
- restart desabilitado;
- limite de tentativas;
- backoff;
- reset após período estável;
- stop manual não reinicia;
- crash repetido chega a FAILED;
- health failure com restart opcional.

### Windows

- processo filho encerrado;
- processo externo não é encerrado;
- PID reutilizado não é confundido;
- caminho com espaços e acentos;
- Engine inicia no login;
- Engine duplicado é impedido.

### Logs

- chunk dividido no meio de linha;
- linha muito longa;
- stderr separado;
- rotação;
- retenção;
- UI desconectada;
- reconexão e cursor.

### Persistência

- reiniciar Engine;
- migração;
- backup;
- recuperação de banco;
- projeto com configuração inválida.

## 4. Critérios de aceite do MVP

1. Cadastrar e executar pelo menos 20 processos de teste, limitado pelos recursos disponíveis.
2. A interface pode fechar e reabrir sem matar projetos.
3. Engine pode reiniciar e reconciliar seu estado sem matar processos externos.
4. Crash de um projeto não afeta outros.
5. Stop manual nunca gera auto-restart.
6. Auto-restart respeita backoff e limite.
7. Health check distingue processo ativo de aplicação saudável.
8. Logs permanecem disponíveis depois que processo termina.
9. Port conflict é informado sem matar o ocupante.
10. Projetos marcados iniciam após login do Windows.
11. Dados persistem após reinicialização.
12. Testes automatizados cobrem as transições críticas.

## 5. Teste de estresse

Executar cenários progressivos com 5, 10, 20 e 50 processos simples. Medir:

- memória do Engine;
- CPU do Engine;
- latência de comandos;
- atraso de logs;
- tempo de inicialização;
- estabilidade de WebSocket.

Não prometer capacidade fixa antes de medir em hardware real.
