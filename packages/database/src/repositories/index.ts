import type { DatabaseSync } from 'node:sqlite';
import { SqliteEventRepository } from './event-repository';
import { SqliteInstanceRepository } from './instance-repository';
import { SqliteProjectRepository } from './project-repository';
import { SqliteSettingsRepository } from './settings-repository';

export interface Repositories {
  projects: SqliteProjectRepository;
  instances: SqliteInstanceRepository;
  events: SqliteEventRepository;
  settings: SqliteSettingsRepository;
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    projects: new SqliteProjectRepository(db),
    instances: new SqliteInstanceRepository(db),
    events: new SqliteEventRepository(db),
    settings: new SqliteSettingsRepository(db),
  };
}

export * from './event-repository';
export * from './instance-repository';
export * from './project-repository';
export * from './settings-repository';
