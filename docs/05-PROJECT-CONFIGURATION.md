# 05 — Configuração de projetos

## 1. Modelo de configuração

Exemplo conceitual:

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "name": "Fiscal API",
  "description": "API local do sistema fiscal",
  "groupId": null,
  "enabled": true,
  "startOnBoot": true,
  "workingDirectory": "C:/dev/fiscal-api",
  "runtime": {
    "executable": "C:/Program Files/nodejs/node.exe",
    "command": "node",
    "args": ["server.js"]
  },
  "environment": {
    "NODE_ENV": "development",
    "PORT": "3000"
  },
  "restartPolicy": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 2000,
    "maxDelayMs": 30000,
    "stableAfterMs": 60000
  },
  "healthCheck": {
    "enabled": false,
    "type": "http",
    "url": "http://127.0.0.1:3000/health",
    "intervalMs": 30000,
    "timeoutMs": 5000,
    "failureThreshold": 3,
    "restartOnUnhealthy": false
  },
  "logging": {
    "maxFileSizeMb": 10,
    "retentionDays": 7
  },
  "shutdown": {
    "gracefulTimeoutMs": 10000
  }
}
```

O schema final deve ser tipado e validado por Zod. O exemplo é ilustrativo e deve ser adaptado aos tipos definitivos.

## 2. Campos obrigatórios

- `id`: UUID gerado pelo sistema.
- `name`: nome legível.
- `workingDirectory`: diretório existente.
- `runtime.executable` ou comando resolvível.
- `runtime.args`: array de argumentos.
- `enabled`: projeto pode ser iniciado?
- `startOnBoot`: inicia com o Engine?

## 3. Segurança de execução

- Preferir executável absoluto.
- `shell=false` por padrão.
- Separar executável e argumentos.
- Não interpolar variáveis em shell.
- Validar que `workingDirectory` existe.
- Não aceitar diretório vazio.
- Não executar automaticamente scripts ao apenas importar o projeto.
- Mostrar claramente o comando final antes de salvar.
- Variáveis sensíveis devem ser mascaradas na UI e excluídas dos logs.
- Evitar persistir segredos em texto puro; avaliar Windows Credential Manager/DPAPI para secrets.

## 4. Descoberta de package.json

Ao selecionar pasta:

1. procurar `package.json` somente na pasta selecionada;
2. ler JSON com tratamento de erro;
3. listar scripts em ordem estável;
4. detectar package manager por lockfile, sem assumir que a detecção é infalível;
5. sugerir comando, mas exigir confirmação do usuário;
6. não executar `install` automaticamente.

Exemplos de sugestões:

- `npm run dev`
- `pnpm run dev`
- `yarn dev`
- `node server.js`

## 5. Executáveis e versões Node

Permitir:

- Node global resolvido pelo PATH;
- caminho absoluto para `node.exe`;
- instalação selecionada do NVM for Windows, quando detectável.

Não executar `nvm use` global automaticamente, pois isso pode alterar a versão usada por outros terminais/projetos. Preferir resolver o caminho absoluto do `node.exe` desejado.

## 6. Grupos

Grupo é organização visual e pode ter política de start em lote. Não implica dependência entre projetos. Dependências devem ser modeladas separadamente em fase futura.

## 7. Importação e exportação

Exportar configurações sem segredos por padrão. Importar deve validar schemaVersion e pedir confirmação para caminhos ausentes. Migração de versões de configuração deve ser explícita.
