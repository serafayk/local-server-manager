# Shell Tauri — Local Server Manager

Camada nativa da Fase 4b. A interface React fica em `apps/desktop/src`; aqui
vivem janela, bandeja, descoberta e inicialização do Engine.

## Como rodar

```powershell
# na raiz do repositório
pnpm --filter @lsm/desktop tauri:dev    # desenvolvimento
pnpm --filter @lsm/desktop tauri:build  # executável + NSIS
```

`tauri:dev`/`tauri:build` executam antes `prepare:engine`, que compila o Engine
e copia `engine.mjs` + `node.exe` para `resources/engine/`. Esses binários não
são versionados.

## Comportamento

- `ensure_engine`:
  1. lê `%LOCALAPPDATA%\LocalServerManager\engine\engine.json` (ou `LSM_DATA_DIR`);
  2. testa TCP em `host:port`; se responder, reutiliza o Engine em execução;
  3. se o arquivo estiver órfão, remove e sobe o Engine embarcado;
  4. aguarda até 20 s pelo endpoint autenticado.
- O Engine é iniciado destacado (`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`).
- Fechar a janela esconde para a bandeja; "Sair da interface" encerra apenas o
  app. O Engine e os projetos continuam rodando (ADR-008/ADR-015).
- A bandeja tem "Abrir painel" e "Sair da interface".

## Requisitos

- Rust estável MSVC (`rustup default stable-x86_64-pc-windows-msvc`)
- Visual Studio Build Tools com C++ (Desktop development)
- WebView2 (já presente no Windows 10/11 atualizado)

## Estrutura

```text
src-tauri/
  Cargo.toml
  build.rs
  tauri.conf.json          # janela, CSP, bundle, recursos
  capabilities/default.json
  icons/                   # gerados por `tauri icon app-icon.svg`
  resources/engine/        # gerado por prepare:engine (gitignored)
  src/main.rs
  src/lib.rs               # ensure_engine, tray, close-to-tray
```

## Diagnóstico

- Engine não sobe: confira `%LOCALAPPDATA%\LocalServerManager\engine\engine.log`
  e se `resources/engine/node.exe` + `engine.mjs` existem.
- Porta/token: `engine/engine.json` é a fonte de verdade.
- UI em branco: rode `pnpm dev` isoladamente e verifique o console; em produção,
  a CSP permite apenas loopback e IPC.
