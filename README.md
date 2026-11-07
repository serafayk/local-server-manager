# Local Server Manager

Gerenciador desktop para cadastrar, iniciar, parar, reiniciar e monitorar múltiplos projetos Node.js no Windows, com recuperação automática após falhas.

## Objetivo

Construir uma experiência semelhante ao Laragon, mas dedicada ao gerenciamento de processos Node.js. O aplicativo deve permitir administrar muitos projetos sem limite artificial de cadastro. A quantidade de processos simultâneos será limitada apenas pelos recursos do computador.

## Princípios obrigatórios

1. **Engine independente da interface:** fechar ou travar a interface não pode encerrar os projetos.
2. **Supervisor próprio:** o MVP não depende de PM2. O Engine usa `child_process.spawn` e implementa seu próprio ciclo de vida.
3. **Segurança por padrão:** comandos são executados sem shell por padrão, com executável e argumentos separados.
4. **Estado explícito:** parada voluntária nunca deve acionar reinicialização automática.
5. **Recuperação controlada:** backoff, limite de tentativas, cooldown e registro de causa.
6. **Persistência:** configurações e histórico operacional ficam em SQLite; logs volumosos ficam em arquivos.
7. **Windows como plataforma-alvo inicial:** tratar corretamente processos filhos, sinais, caminhos, permissões e inicialização.
8. **Sem promessas falsas:** PID ativo não significa aplicação saudável. Health check é uma dimensão separada.

## Documentos

- [Visão do produto e requisitos](docs/01-PRODUCT.md)
- [Arquitetura geral](docs/02-ARCHITECTURE.md)
- [Engine e módulos](docs/03-ENGINE.md)
- [Ciclo de vida e recuperação](docs/04-PROCESS-LIFECYCLE.md)
- [Configuração de projetos](docs/05-PROJECT-CONFIGURATION.md)
- [Contratos e API](docs/06-API-CONTRACTS.md)
- [Banco de dados](docs/07-DATABASE.md)
- [Desktop e experiência do usuário](docs/08-DESKTOP-UX.md)
- [Windows, instalação e segurança](docs/09-WINDOWS-SECURITY.md)
- [Logs e observabilidade](docs/10-LOGGING-MONITORING.md)
- [Testes e critérios de aceite](docs/11-TESTING.md)
- [Roadmap de implementação](docs/12-ROADMAP.md)
- [Instruções para agente de programação](docs/13-AGENT-INSTRUCTIONS.md)
- [Decisões técnicas](docs/14-ADR.md)
- [Desenvolvimento, execução e limitações](docs/15-DEVELOPMENT.md)

## Estado atual

**Fases 0, 1, 2 e 3 concluídas** (2026-11-07). O Engine cadastra projetos, inicia/para/reinicia processos reais sem shell, supervisiona com auto-restart e backoff, reconcilia órfãos após queda, grava logs JSONL com retenção e expõe uma API local autenticada (HTTP + WebSocket) com descoberta por `engine.json`.

Ainda não implementados: health check, métricas, portas e desktop. Consulte [docs/15-DEVELOPMENT.md](docs/15-DEVELOPMENT.md) e `CHANGELOG.md`.

## Stack proposta

| Camada            | Tecnologia                                                     |
| ----------------- | -------------------------------------------------------------- |
| Desktop           | Tauri 2                                                        |
| Interface         | React + TypeScript + Vite                                      |
| Estilo            | Tailwind CSS + shadcn/ui                                       |
| Engine            | Node.js + TypeScript                                           |
| Banco             | SQLite                                                         |
| Acesso ao banco   | Drizzle ORM ou repositório SQL tipado                          |
| Validação         | Zod                                                            |
| Comunicação local | Named Pipe no Windows ou HTTP loopback autenticado + WebSocket |
| Testes            | Vitest + Playwright                                            |
| Monorepo          | pnpm workspaces                                                |
| Empacotamento     | Tauri bundler + instalador Windows                             |

As versões devem ser escolhidas e fixadas no início da implementação, após verificar compatibilidade atual. Não instalar dependências sem necessidade.

## Escopo inicial

- Cadastro, edição, importação e remoção de projetos.
- Detecção de scripts do `package.json`.
- Comando, argumentos, diretório de trabalho, ambiente e executável configuráveis.
- Start, stop, restart individual e em lote.
- Supervisor com auto-restart e backoff.
- Logs stdout/stderr/system.
- Detecção de portas ocupadas.
- Health check HTTP/TCP opcional.
- Métricas básicas de processo.
- Engine independente do desktop.
- Inicialização automática após login do Windows.
- SQLite e logs rotacionados.

## Fora do MVP

- Gerenciar PHP, Python, bancos de dados ou serviços genéricos.
- Controle remoto pela internet.
- Exposição do painel na rede.
- Deploy ou publicação de aplicações.
- Gerenciamento de containers Docker.
- Atualização automática complexa do Engine.
- Execução de comandos arbitrários enviados por rede.

## Como usar esta documentação

Esta documentação é a especificação inicial. Se uma implementação exigir alteração arquitetural, o agente deve explicar o motivo, atualizar o ADR correspondente e manter os princípios obrigatórios. Não implementar tudo em uma única etapa: seguir o roadmap e manter o projeto compilável e testado a cada fase.
