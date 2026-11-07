# 08 — Desktop e experiência do usuário

> **Status (Fase 4a):** telas de Dashboard, Projetos, Detalhes (visão geral/logs/configuração/histórico),
> Logs, Eventos e Configurações implementadas em `apps/desktop`, com cliente tipado e WebSocket.
> Tray e shell Tauri ficam para a Fase 4b (ADR-015).

## 1. Direção visual

Aplicativo desktop escuro por padrão, visual técnico e limpo, inspirado em ferramentas de desenvolvimento. Priorizar densidade de informação sem poluição visual.

## 2. Navegação

- Dashboard
- Projetos
- Grupos
- Logs
- Eventos
- Configurações

## 3. Dashboard

Indicadores:

- projetos em execução;
- projetos parados;
- projetos com falha;
- projetos não saudáveis;
- CPU total dos processos gerenciados;
- RAM total estimada;
- Engine conectado/desconectado.

Lista de projetos com:

- nome;
- grupo;
- status;
- porta;
- PID;
- uptime;
- CPU/RAM;
- último evento;
- ações Start, Stop, Restart e Logs.

## 4. Tela de projetos

- busca por nome/caminho;
- filtro por estado e grupo;
- ordenação;
- seleção múltipla;
- start/stop em lote;
- cadastro, edição e remoção;
- confirmação antes de remover projeto que esteja em execução.

Remover cadastro não deve apagar a pasta original nem arquivos do projeto. Se estiver rodando, exigir parar primeiro ou oferecer ação explícita de parar e remover.

## 5. Cadastro em etapas

1. Pasta e identificação.
2. Comando e runtime.
3. Variáveis de ambiente.
4. Porta e health check.
5. Política de reinicialização.
6. Inicialização automática.
7. Revisão do comando antes de salvar.

## 6. Tela de detalhes

Abas:

- Visão geral;
- Logs;
- Configuração;
- Histórico;
- Métricas.

## 7. Tray e fechamento

- Fechar janela deve minimizar para bandeja, se usuário configurar.
- Sair da interface não deve encerrar Engine.
- A opção “Encerrar Engine” deve ser separada e explicar o que acontecerá com os projetos.
- Menu tray: abrir painel, iniciar todos selecionados, parar todos, sair da interface.

## 8. Acessibilidade e usabilidade

- Estados devem ter texto além de cor.
- Ações destrutivas exigem confirmação.
- Botões desabilitados devem explicar motivo.
- Mostrar erros acionáveis, não apenas “falha”.
- Não bloquear UI durante operações.
- Logs longos devem ser virtualizados.
- Interface deve tolerar Engine indisponível e oferecer reconexão.
