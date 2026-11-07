import type { ProjectConfig } from '@lsm/contracts';
import { newId } from '@lsm/shared';
import { parseCreateProjectRequest } from '@lsm/validation';

/**
 * Constrói uma ProjectConfig completa e válida para testes, reutilizando o
 * mesmo caminho de validação da produção.
 */
export function makeProjectConfig(overrides: Record<string, unknown> = {}): ProjectConfig {
  const fields = parseCreateProjectRequest({
    name: `projeto-${Math.random().toString(36).slice(2, 8)}`,
    workingDirectory: 'C:\\dev\\projeto',
    runtime: { executable: 'node', args: ['index.js'] },
    ...overrides,
  });
  return {
    id: newId(),
    ...fields,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
