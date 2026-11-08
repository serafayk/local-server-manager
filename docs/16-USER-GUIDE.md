# 16 — Guia do usuário

Aplicativo desktop para iniciar, parar e monitorar projetos Node.js no Windows.
O Engine roda separado da interface; fechar a janela **não** encerra os projetos.

## 1. Instalação

1. Execute `Local Server Manager_<versão>_x64-setup.exe`.
2. A instalação é **por usuário** (não exige administrador).
3. Abra pelo atalho do Menu Iniciar ou pela bandeja.

Requisitos: Windows 10/11 64-bit, WebView2 (presente em instalações atualizadas).

## 2. Primeiro projeto

1. **Projetos → Novo projeto**.
2. Informe o nome e a pasta (caminho absoluto).
3. Clique em **Detectar** para ler `package.json` e lockfiles.
4. Escolha um script (ex.: `dev`) ou use comando personalizado
   (executável + argumentos, um por linha).
5. Revise a etapa **Execução** (auto-restart, porta, health check, boot) e crie.
6. Use **Iniciar** na lista ou na tela do projeto.

## 3. Status

- **Parado / Iniciando / Executando / Parando / Caindo / Reiniciando / Falhou**:
  estado do processo.
- **Saudável / Não saudável**: resultado do health check, independente de o
  processo estar vivo (`Executando · Não saudável` é possível).
- **Porta em uso**: aviso ao lado da porta quando outro processo já ocupa a porta
  configurada. O app não mata esse processo.

## 4. Logs e eventos

- **Logs** combina histórico (HTTP) e saída ao vivo (WebSocket), com filtros por
  stream e texto, seleção de instância e auto-scroll.
- **Eventos** mostra a auditoria (start, stop, crash, recovery, health, porta).
- Logs continuam disponíveis depois que o processo termina.

## 5. Recuperação automática

Crashes disparam reinícios com backoff exponencial até `maxRetries`; depois o
projeto fica **Falhou** até um start manual. Stop manual nunca reinicia.
O contador zera após o período estável configurado.

## 6. Inicialização com o Windows

Em **Configurações → Inicialização com o Windows**, habilite
**Iniciar o Engine no login**. Isso cria uma tarefa no Agendador de Tarefas
(`Local Server Manager Engine`) que inicia o Engine no login do usuário.
Projetos marcados com **Iniciar no boot** sobem junto.

## 7. Backup e restauração

- **Criar backup** grava uma cópia do banco em
  `%LOCALAPPDATA%\LocalServerManager\backups\`.
- **Restaurar** para os projetos, agenda a restauração e reinicia o Engine.
  O banco atual é copiado para `manager-pre-restore-*` antes da troca.

## 8. Onde ficam os dados

```text
%LOCALAPPDATA%\LocalServerManager\
  data\manager.sqlite
  logs\<projeto>\<instancia>.log
  backups\
  engine\engine.log
  engine\shell.log
```

Nada é gravado na pasta de instalação. Remover um projeto do cadastro **não**
apaga a pasta original.

## 9. Desinstalação

O desinstalador remove o app e a tarefa de autostart. Os dados em
`%LOCALAPPDATA%\LocalServerManager` são preservados; apague manualmente se
quiser remover tudo. As pastas dos seus projetos nunca são tocadas.

## 10. Problemas comuns

| Sintoma                  | O que verificar                                                     |
| ------------------------ | ------------------------------------------------------------------- |
| "Engine não encontrado"  | Inicie o Engine (`pnpm engine` em desenvolvimento) ou reabra o app. |
| Projeto não sobe         | Diretório/executável, porta ocupada e logs do projeto.              |
| Logs sem atualização     | Indicador de conexão (canto superior); reconecte recarregando.      |
| Restauração não aplicada | É necessário reiniciar o Engine (o app faz automaticamente).        |
| Autostart não aparece    | Recurso disponível apenas no app instalado (não no navegador).      |
