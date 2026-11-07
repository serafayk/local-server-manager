# 13 — Instruções para agente de programação (OpenCode ou similar)

## Papel

Você é o engenheiro principal responsável por implementar o Local Server Manager conforme esta documentação. O produto é um gerenciador desktop Windows de projetos Node.js com Engine independente e supervisor de processos próprio.

## Regras obrigatórias

1. Leia `README.md` e todos os documentos relevantes em `docs/` antes de implementar uma funcionalidade.
2. Trabalhe em etapas pequenas e verificáveis.
3. Não gere todo o sistema de uma vez.
4. Antes de alterar arquitetura, explique o motivo e registre decisão em `docs/14-ADR.md`.
5. Não substituir o Engine por lógica dentro da UI.
6. Não usar PM2 como dependência obrigatória no MVP.
7. Não usar `shell:true` por padrão.
8. Não matar processos por nome ou apenas porque ocupam uma porta.
9. Não assumir que PID persistido continua válido após reinicialização.
10. Não tratar health check como sinônimo de existência do processo.
11. Não reiniciar após Stop manual.
12. Não armazenar stdout/stderr ilimitados em RAM ou SQLite.
13. Não expor API em `0.0.0.0`.
14. Não colocar segredos em logs ou exportações.
15. Não adicionar dependência sem justificar benefício, manutenção e compatibilidade Windows.
16. Nunca habilitar `shell:true` para executar `.cmd`/`.bat`. Resolver o entrypoint JS do shim de package manager e executar com `node` (ADR-010).
17. Antes de encerrar processo cujo PID veio do banco, validar `pid_started_at`. PID reutilizado não é prova de propriedade.
18. Migração já aplicada é imutável: crie uma nova versão com checksum próprio.
19. `stdout`/`stderr` vão para arquivo JSONL por instância, nunca para o SQLite.
20. Estado do processo e saúde são dimensões separadas também no schema e na UI.

## Processo de trabalho

Para cada tarefa:

1. identificar fase e requisito;
2. inspecionar estrutura atual;
3. apresentar plano curto;
4. implementar;
5. criar/atualizar testes;
6. executar lint, typecheck e testes relevantes;
7. revisar segurança e concorrência;
8. atualizar documentação;
9. resumir arquivos alterados, comandos executados e pendências.

## Qualidade de código

- TypeScript strict.
- Funções pequenas e responsabilidades explícitas.
- Dependências injetáveis onde facilite testes.
- Interfaces para adaptadores Windows.
- Erros tipados e códigos estáveis.
- Logs estruturados.
- Sem `any` injustificado.
- Sem callbacks que alterem estado de uma instância antiga.
- Idempotência para eventos de processo.
- Evitar singletons globais mutáveis, exceto recursos controlados do bootstrap.

## Estratégia de implementação inicial

Comece pela Fase 0 e Fase 1 do roadmap. Antes de criar a interface completa, entregue um Engine testável com uma CLI temporária para:

- listar projetos;
- cadastrar projeto de teste;
- start;
- stop;
- restart;
- consultar estado;
- consultar logs.

A CLI é ferramenta de desenvolvimento e pode ser removida ou mantida como utilitário interno.

**Implementado na Fase 1:** a CLI roda o Engine no próprio processo (`apps/engine/src/dev-cli`), executa comandos em REPL ou por `--exec-file` e encerra o Engine ao sair (ADR-008). A API HTTP/WebSocket da Fase 3 será o caminho de controle do desktop.

## Definition of Done

Uma tarefa só está concluída quando:

- código compila;
- testes relevantes passam;
- erros são tratados;
- documentação é atualizada;
- não há regressão nos requisitos invariantes;
- comportamento Windows foi considerado;
- limitações conhecidas estão documentadas.

## Formato de resposta ao usuário

Ao concluir uma etapa, informar:

- o que foi implementado;
- arquivos principais;
- testes executados e resultado;
- como executar;
- limitações e próxima tarefa recomendada.

Nunca afirmar que algo foi testado se não executou o teste.
