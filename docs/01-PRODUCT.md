# 01 — Visão do produto e requisitos

## 1. Problema

Desenvolvedores que mantêm diversos projetos Node.js localmente acabam usando vários terminais, scripts manuais ou ferramentas diferentes para iniciar e encerrar servidores. É difícil saber o que está rodando, qual porta está ocupada, por que um processo caiu e como recuperá-lo automaticamente.

## 2. Proposta

O Local Server Manager é um aplicativo desktop para Windows que centraliza o ciclo de vida de projetos Node.js. Ele oferece uma interface visual semelhante ao Laragon, mas mantém um Engine independente que supervisiona os processos.

## 3. Público e cenário

Usuário principal: desenvolvedor que executa diversos projetos Node.js no mesmo computador, incluindo APIs, Next.js, Vite, Express, workers e scripts contínuos.

## 4. Requisitos funcionais

### RF-001 — Cadastro de projeto

O usuário deve cadastrar projeto informando nome, diretório, executável, comando, argumentos e variáveis de ambiente.

### RF-002 — Detecção de scripts

Ao selecionar uma pasta com `package.json`, o sistema deve ler `scripts` e permitir escolher um script. A detecção é uma conveniência, não uma obrigação para comandos personalizados.

### RF-003 — Controle individual

O usuário deve iniciar, parar e reiniciar um projeto.

### RF-004 — Controle em lote

O usuário deve iniciar ou parar projetos selecionados e grupos. Operações em lote devem ter resultado individual por projeto.

### RF-005 — Auto-restart

Quedas inesperadas podem provocar reinício automático conforme política configurada. Stop manual, remoção e desligamento solicitado não podem disparar restart.

### RF-006 — Logs

Exibir stdout, stderr e eventos internos em tempo real, com filtros e histórico.

### RF-007 — Health check

Permitir verificação HTTP ou TCP independente da existência do PID. O recurso deve ser opcional.

### RF-008 — Portas

Exibir a porta configurada e detectar conflito antes ou durante a inicialização. Não matar automaticamente o processo que ocupa a porta.

### RF-009 — Inicialização

Permitir marcar projetos para iniciar quando o Engine for iniciado pelo Windows.

### RF-010 — Persistência

Projetos, políticas, configurações e histórico devem persistir após reinicialização do computador.

### RF-011 — Métricas

Exibir PID, tempo ativo, CPU e memória quando disponíveis. Falha ao obter uma métrica não pode derrubar o supervisor.

### RF-012 — Importação

Permitir importar configuração de projeto a partir de uma pasta existente.

## 5. Requisitos não funcionais

- RNF-001: fechar a janela desktop não encerra o Engine nem os projetos.
- RNF-002: Engine não deve depender do processo React/Tauri para operar.
- RNF-003: falha de um projeto não pode derrubar o Engine nem outros projetos.
- RNF-004: comandos não devem ser executados por shell por padrão.
- RNF-005: API de controle não pode escutar em interfaces externas.
- RNF-006: operações críticas devem ser registradas.
- RNF-007: logs devem ter rotação e retenção configuráveis.
- RNF-008: o banco deve ter migrações versionadas e backup antes de migrações destrutivas.
- RNF-009: UI deve continuar responsiva com muitos logs e projetos.
- RNF-010: nenhum número fixo de projetos deve ser imposto pelo produto; documentar limites práticos de recursos do sistema.

## 6. Personas de uso e jornadas

### Cadastrar um projeto

1. Selecionar “Adicionar projeto”.
2. Escolher pasta.
3. Sistema detecta `package.json`.
4. Usuário escolhe script ou comando personalizado.
5. Configura ambiente, porta e política de restart.
6. Salva e pode iniciar.

### Recuperar uma queda

1. Processo encerra inesperadamente.
2. Engine registra código/sinal e causa.
3. Política decide se deve reiniciar.
4. Engine aplica backoff.
5. Processo é iniciado novamente.
6. UI recebe eventos e mostra contador de tentativas.

### Encerrar manualmente

1. Usuário clica Stop.
2. Engine marca intenção como parada manual antes de encerrar.
3. Engine tenta encerramento gracioso e depois forçado se necessário.
4. Estado final é STOPPED.
5. Nenhum restart automático é iniciado.

## 7. Critérios de produto

O MVP só é considerado utilizável quando:

- Um projeto pode ser cadastrado sem editar arquivos do projeto original.
- A interface pode ser fechada e reaberta sem perder processos.
- Um processo que cai pode ser reiniciado automaticamente.
- Um Stop manual permanece parado.
- Logs são acessíveis após o processo terminar.
- O Engine volta após login/reinicialização do Windows e inicia projetos habilitados.
