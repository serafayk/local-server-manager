# 16 — Guia do usuário

Aplicativo desktop para iniciar, parar e monitorar projetos Node.js no Windows.
O Engine roda separado da interface; fechar a janela **não** encerra os projetos.

## 1. Instalação

1. Execute `Local Server Manager_<versão>_x64-setup.exe`.
2. A instalação é **por usuário** (não exige administrador).
3. Abra pelo atalho do Menu Iniciar ou pela bandeja.

Requisitos: Windows 10/11 64-bit, WebView2 (presente em instalações atualizadas).

## 2. Primeiro projeto

Há dois caminhos.

### 2.1 Adicionar pela raiz (recomendado para monorepos)

1. **Projetos → Adicionar pela raiz**.
2. **Escolher pasta** (ou digite o caminho) e clique em **Detectar**.
3. O Engine lista os serviços encontrados e já preenche nome, script, porta e health.
4. Revise: desmarque o que não quiser, ajuste nome/porta e defina o grupo.
5. **Criar N projeto(s)**.

Apps Expo/React Native vêm desmarcados. Portas repetidas bloqueiam a criação.

### 2.2 Cadastro manual

1. **Projetos → Novo projeto**.
2. Informe o nome e a pasta (**Escolher pasta** abre o seletor do Windows).
3. Use **Detectar** para ler `package.json` e lockfiles, ou ignore.
4. Escolha um script (`start` para produção, `dev` para desenvolvimento) ou use
   comando personalizado (executável + argumentos, um por linha).
5. Etapa **Execução**: porta, health check e boot. Os demais campos ficam em
   **Configuração avançada**.
6. **Criar projeto** e use **Iniciar**.

> `start` exige build prévio em projetos Next.js. Nesse caso use `dev` ou rode
> `next build` antes.

## 3. Status

- **Parado / Iniciando / Executando / Parando / Caindo / Reiniciando / Falhou**:
  estado do processo.
- **Saudável / Não saudável**: resultado do health check, independente de o
  processo estar vivo (`Executando · Não saudável` é possível).
- **Porta em uso**: aviso ao lado da porta quando outro processo já ocupa a porta
  configurada. O app não mata esse processo.
- **Memória**: working set da árvore inteira (raiz + filhos). O sufixo `(Np)`
  indica quantos processos compõem o projeto, por exemplo `pnpm` + servidor.
  O detalhe (aba Métricas) mostra memória privada e os maiores processos.

## 4. Logs e eventos

- **Logs** combina histórico (HTTP) e saída ao vivo (WebSocket), com filtros por
  stream e texto, seleção de instância e auto-scroll.
- **Eventos** mostra a auditoria (start, stop, crash, recovery, health, porta).
- Logs continuam disponíveis depois que o processo termina.

## 5. Recuperação automática

Crashes disparam reinícios com backoff exponencial até `maxRetries`; depois o
projeto fica **Falhou** até um start manual. Stop manual nunca reinicia.
O contador zera após o período estável configurado.

**Falhas de ambiente não entram em loop.** Porta ocupada (`EADDRINUSE`), build
ausente (`next start` sem `.next/BUILD_ID`), dependência ausente, banco fora do ar
e permissão negada interrompem o retry imediatamente. O projeto fica **Falhou** e
o detalhe mostra **Última falha** com a causa. Corrija e clique em **Iniciar**.

## 6. Editar e duplicar

- **Editar** aparece na linha da lista e no detalhe.
- Com o projeto em execução, o app oferece **Parar e editar**.
- **Duplicar** cria outro projeto com a mesma configuração, sem copiar porta nem
  boot (evita conflito imediato).

### Perfil de memória

Em **Execução → Perfil de memória** você aplica `NODE_OPTIONS` ao projeto
(herdado por pnpm → tsx/next → node):

| Perfil        | Efeito                                               |
| ------------- | ---------------------------------------------------- |
| Desligado     | não define nada                                      |
| Baixo         | `--max-old-space-size=256 --max-semi-space-size=8`   |
| Médio         | `--max-old-space-size=512 --max-semi-space-size=16`  |
| Alto          | `--max-old-space-size=1024 --max-semi-space-size=32` |
| Personalizado | você informa heap e semi-espaço                      |

Isso limita o **crescimento** do heap e o espaço da geração jovem; não reduz o
consumo base. A maior economia continua sendo rodar build de produção em vez de
`tsx watch`/`next dev`. Em **Adicionar pela raiz** há o mesmo seletor, aplicado a
todos os projetos criados.

> `--optimize-for-size` não é aceito em `NODE_OPTIONS`; só como flag direta do
> `node` (projetos com `node dist/...`).

## 7. Inicialização com o Windows

Em **Configurações → Inicialização com o Windows**, habilite
**Iniciar o Engine no login**. Isso cria uma tarefa no Agendador de Tarefas
(`Local Server Manager Engine`) que inicia o Engine no login do usuário.
Projetos marcados com **Iniciar no boot** sobem junto.

## 8. Backup e restauração

- **Criar backup** grava uma cópia do banco em
  `%LOCALAPPDATA%\LocalServerManager\backups\`.
- **Restaurar** para os projetos, agenda a restauração e reinicia o Engine.
  O banco atual é copiado para `manager-pre-restore-*` antes da troca.

## 9. Onde ficam os dados

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

## 10. Desinstalação

O desinstalador remove o app e a tarefa de autostart. Os dados em
`%LOCALAPPDATA%\LocalServerManager` são preservados; apague manualmente se
quiser remover tudo. As pastas dos seus projetos nunca são tocadas.

## 11. Problemas comuns

| Sintoma                     | O que verificar                                                     |
| --------------------------- | ------------------------------------------------------------------- |
| "Engine não encontrado"     | Inicie o Engine (`pnpm engine` em desenvolvimento) ou reabra o app. |
| Projeto não sobe            | Diretório/executável, porta ocupada e logs do projeto.              |
| "Porta já está em uso"      | Outro processo ocupa a porta. Encerre-o ou altere a porta.          |
| "Build de produção ausente" | Use o script `dev` ou rode o build (`next build`).                  |
| Logs sem atualização        | Indicador de conexão (canto superior); reconecte recarregando.      |
| Restauração não aplicada    | É necessário reiniciar o Engine (o app faz automaticamente).        |
| Autostart não aparece       | Recurso disponível apenas no app instalado (não no navegador).      |
