# 09 — Windows, instalação e segurança

## 1. Plataforma

Windows 10/11 64-bit como primeira plataforma. Encapsular particularidades em adaptadores.

## 2. Engine em background

Implementado na Fase 6 (ADR-017):

- o Engine é empacotado como recurso do app (`node.exe` + `engine.mjs`);
- o shell Tauri oferece **Iniciar o Engine no login** em Configurações, criando a tarefa
  `Local Server Manager Engine` com `schtasks /SC ONLOGON /RL LIMITED`;
- o padrão é desligado; habilitar/desabilitar é explícito e registrado em `shell.log`;
- o desinstalador remove a tarefa via hook NSIS;
- instância única continua garantida pelo lock do Engine.

MVP (histórico):

- instalar Engine junto com o aplicativo;
- registrar tarefa no Agendador de Tarefas para iniciar no login do usuário;
- permitir desativar inicialização automática;
- garantir instância única;
- registrar logs de bootstrap.

A instalação deve informar claramente o que será configurado no Windows e oferecer desinstalação limpa da tarefa.

## 3. Serviço Windows futuro

Se houver necessidade de iniciar antes do login, avaliar serviço Windows com wrapper mantido e confiável. Não implementar serviço próprio improvisado na primeira versão.

## 4. Processos filhos

No Windows, `child_process.spawn` não oferece a mesma semântica de sinais de Unix. Implementar um adaptador de encerramento e testes de árvore de processos.

Considerar Job Objects para vincular processos descendentes à instância gerenciada. Avaliar biblioteca ou pequeno módulo nativo bem mantido; documentar fallback. `taskkill /T` pode ser fallback, mas deve ser restrito ao PID/árvore que o Engine iniciou e verificou.

## 5. Segurança da comunicação

> **Implementado na Fase 3 (ADR-014):** HTTP em `127.0.0.1` com porta efêmera,
> token de 32 bytes por execução publicado em `engine/engine.json`, comparação
> em tempo constante, validação de `Host` (anti DNS rebinding), CORS por
> allowlist, corpo máximo de 1 MB e WebSocket autenticado. Named Pipe com ACL
> continua como evolução.

- Preferir Named Pipe com ACL para usuário atual.
- Se usar HTTP, bind somente em `127.0.0.1`.
- Token aleatório por instalação/execução, armazenado com proteção adequada.
- Validar Origin/Host e autenticação.
- Limitar tamanho de payload.
- Não aceitar caminhos arbitrários sem validação.
- Não oferecer endpoint genérico para executar shell.
- Não expor API na rede local.

## 6. Execução de comandos

- `shell:false` por padrão.
- `executable` e `args` separados.
- `cwd` validado.
- Não montar `cmd.exe /c` com texto não confiável.
- Se comando shell for inevitável, exigir opção explícita e aviso de risco.
- Sanitizar dados sensíveis dos logs.
- Não executar script durante descoberta/importação.

## 7. Segredos

Variáveis sensíveis não devem aparecer em logs, telas de diagnóstico ou exportações por padrão. Avaliar Windows Credential Manager ou DPAPI para valores secretos. Não alegar criptografia segura se a implementação não foi validada.

## 8. Atualização

Atualizar desktop e Engine de forma coordenada. Não substituir binários enquanto Engine estiver executando. Criar procedimento de parar/atualizar/reiniciar e preservar banco/configurações. Rollback deve ser possível.

## 9. Desinstalação

Implementado via NSIS (ADR-017):

- o desinstalador remove a tarefa de autostart (`schtasks /Delete`);
- **não** apaga `%LOCALAPPDATA%\LocalServerManager` nem as pastas dos projetos;
- o usuário pode remover os dados manualmente após desinstalar;
- o instalador é por usuário (`currentUser`), sem exigir administrador.
