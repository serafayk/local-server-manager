import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../tests/helpers';
import { scanProjectRoot } from './monorepo-scanner';

const directories: string[] = [];

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  directories.push(directory);
  return directory;
}

function writeFile(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

function createMonorepo(): string {
  const root = tempDir('lsm-scan-');

  writeFile(root, 'package.json', JSON.stringify({ name: 'demo-repo', private: true }));
  writeFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFile(root, '.env', 'CORE_PORT=4010\nAI_PORT=4011\nDATABASE_URL=postgres://local\n');

  writeFile(
    root,
    'apps/core/package.json',
    JSON.stringify({
      name: '@demo/core',
      scripts: { start: 'tsx src/index.ts', dev: 'tsx watch src/index.ts' },
    }),
  );
  writeFile(
    root,
    'apps/core/src/config.ts',
    'export const schema = z.object({\n  CORE_PORT: z.coerce.number().default(4001),\n});\n',
  );
  writeFile(
    root,
    'apps/core/src/routes/health.ts',
    'app.get("/health", async () => ({ ok: true }));',
  );

  writeFile(
    root,
    'apps/gateway/package.json',
    JSON.stringify({
      name: '@demo/gateway',
      scripts: { start: 'node dist/index.js' },
    }),
  );
  writeFile(
    root,
    'apps/gateway/src/config.ts',
    'export const schema = z.object({\n  AI_PORT: z.coerce.number().default(4002),\n});\n',
  );

  writeFile(
    root,
    'apps/web/package.json',
    JSON.stringify({
      name: '@demo/web',
      scripts: { dev: 'next dev', start: 'next start' },
      dependencies: { next: '15.5.0' },
    }),
  );

  writeFile(
    root,
    'packages/shared/package.json',
    JSON.stringify({ name: '@demo/shared', scripts: { build: 'tsc' } }),
  );

  writeFile(
    root,
    'apps/mobile/package.json',
    JSON.stringify({
      name: '@demo/mobile',
      scripts: { start: 'expo start' },
      dependencies: { expo: '~58.0.0' },
    }),
  );

  return root;
}

describe('scanProjectRoot', () => {
  it('detecta apps do monorepo, portas, health e scripts seguros', () => {
    const root = createMonorepo();
    const result = scanProjectRoot(root);

    expect(result.isMonorepo).toBe(true);
    expect(result.groupSuggestion).toBe(basename(root));
    expect(result.projects).toHaveLength(5);

    const core = result.projects.find((project) => project.relativeDirectory === 'apps/core');
    expect(core).toMatchObject({
      packageName: '@demo/core',
      script: 'start',
      runnable: true,
      port: 4010,
      portSource: 'env',
      healthType: 'http',
      healthTarget: 'http://127.0.0.1:4010/health',
      name: `${basename(root)} · Core`,
      packageManager: 'pnpm',
      recommended: true,
    });
    expect(core?.notes.some((note) => /watcher/i.test(note))).toBe(false);

    const gateway = result.projects.find((project) => project.relativeDirectory === 'apps/gateway');
    expect(gateway).toMatchObject({ port: 4011, portSource: 'env', script: 'start' });
    // Sem rota /health detectada: usa TCP.
    expect(gateway?.healthType).toBe('tcp');

    const web = result.projects.find((project) => project.relativeDirectory === 'apps/web');
    expect(web).toMatchObject({ script: 'dev', runnable: true, port: null, portSource: 'none' });
    expect(web?.healthType).toBe('tcp');
    expect(web?.notes.some((note) => /build/.test(note))).toBe(true);

    const shared = result.projects.find(
      (project) => project.relativeDirectory === 'packages/shared',
    );
    expect(shared?.runnable).toBe(false);
    expect(shared?.script).toBeNull();
    expect(shared?.recommended).toBe(false);

    const mobile = result.projects.find((project) => project.relativeDirectory === 'apps/mobile');
    expect(mobile?.recommended).toBe(false);
    expect(mobile?.notes.some((note) => /Expo/.test(note))).toBe(true);
  });

  it('usa default do config quando não há .env', () => {
    const root = tempDir('lsm-scan-config-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'single' }));
    writeFile(
      root,
      'src/config.ts',
      'export const schema = z.object({\n  APP_PORT: z.coerce.number().int().default(4_500),\n});\n',
    );

    const result = scanProjectRoot(root);
    expect(result.isMonorepo).toBe(false);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({ port: 4500, portSource: 'config' });
  });

  it('rejeita diretório inexistente', () => {
    expect(() => scanProjectRoot('C:\\nao-existe-para-scan')).toThrowError(/não encontrado/i);
  });
});
