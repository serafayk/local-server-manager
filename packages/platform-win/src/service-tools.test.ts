import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../tests/helpers';
import { detectDocker, detectPostgresInstallations } from './service-tools';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

function fakeRoot(): string {
  const root = createTempDir('lsm-tools-');
  directories.push(root);
  for (const version of ['9.0', '16']) {
    const bin = join(root, version, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'postgres.exe'), '', 'utf8');
  }
  return root;
}

describe('detecção de ferramentas', () => {
  it('encontra instalações do PostgreSQL e ordena pela maior versão', () => {
    const installations = detectPostgresInstallations([fakeRoot()]);
    expect(installations.map((item) => item.version)).toEqual(['16', '9.0']);
    expect(installations[0]?.binDir).toContain(join('16', 'bin'));
    expect(installations[0]?.service).toBe('postgresql-x64-16');
  });

  it('ignora raízes inexistentes', () => {
    expect(detectPostgresInstallations(['C:\\caminho\\que\\nao\\existe'])).toEqual([]);
  });

  it('detecta ausência do Docker sem lançar', () => {
    const info = detectDocker('docker-inexistente-lsm');
    expect(info.available).toBe(false);
    expect(info.error).toBeTruthy();
  });

  it('reporta Docker disponível quando o executável responde', () => {
    const info = detectDocker(process.execPath);
    expect(info.available).toBe(true);
    expect(info.version).toBeTruthy();
    // `node compose version` falha: plugin Compose fica nulo.
    expect(info.composeVersion).toBeNull();
  });
});
