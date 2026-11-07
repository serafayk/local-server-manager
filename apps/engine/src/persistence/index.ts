/**
 * Camada de persistência do Engine.
 *
 * Os repositórios SQL vivem em `@lsm/database` (compartilhados com a Fase 3)
 * e são instanciados aqui para manter um único ponto de composição. O Engine
 * nunca acessa SQLite fora dos repositórios.
 */
export { createRepositories } from '@lsm/database';
export type { Repositories } from '@lsm/database';
export type {
  AppendEventInput,
  ListEventsOptions,
  ProcessInstance,
  SystemEvent,
} from '@lsm/database';
