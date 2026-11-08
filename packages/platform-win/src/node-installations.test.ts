import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../tests/helpers';
import { detectNodeInstallations } from './node-installations';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('detectNodeInstallations', () => {
  it('detecta versões do NVM e o Node do Engine em ordem decrescente', () => {
    const nvmHome = createTempDir('lsm-nvm-');
    directories.push(nvmHome);

    for (const version of ['v20.11.0', 'v22.1.0']) {
      const directory = join(nvmHome, version);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'node.exe'), '', 'utf8');
    }
    mkdirSync(join(nvmHome, 'sem-versao'), { recursive: true });
    writeFileSync(join(nvmHome, 'sem-versao', 'node.exe'), '', 'utf8');

    const installations = detectNodeInstallations({
      env: {
        NVM_HOME: nvmHome,
        ProgramFiles: join(nvmHome, 'inexistente'),
        APPDATA: '',
      },
      platform: 'win32',
      engineExecutable: process.execPath,
      engineVersion: 'v24.5.0',
    });

    const versions = installations.map((item) => item.version);
    expect(versions).toContain('20.11.0');
    expect(versions).toContain('22.1.0');
    expect(versions).toContain('24.5.0');
    expect(versions).not.toContain('sem-versao');

    expect(installations.find((item) => item.version === '22.1.0')?.source).toBe('nvm');

    const sorted = [...versions].sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }),
    );
    expect(versions).toEqual(sorted);
  });

  it('retorna vazio fora do Windows e com pastas ausentes', () => {
    expect(detectNodeInstallations({ platform: 'linux' })).toEqual([]);
    expect(
      detectNodeInstallations({
        env: { NVM_HOME: 'C:\\nao-existe', ProgramFiles: 'C:\\nao-existe', APPDATA: '' },
        platform: 'win32',
        engineExecutable: 'C:\\nao-existe\\node.exe',
      }),
    ).toEqual([]);
  });
});
