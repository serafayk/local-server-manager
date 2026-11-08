import { X509Certificate } from 'node:crypto';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { CertificateManager } from './certificate-manager';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const directories: string[] = [];

function tempDir(): string {
  const directory = createTempDir('lsm-certs-');
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('CA e certificados locais', () => {
  it('cria uma CA válida e reutiliza entre inicializações', async () => {
    const dir = tempDir();
    const manager = new CertificateManager({ certsDir: dir, logger });

    await manager.initialize();
    const pem = manager.caPem();
    expect(pem).toContain('BEGIN CERTIFICATE');

    const parsed = new X509Certificate(pem as string);
    expect(parsed.ca).toBe(true);

    const second = new CertificateManager({ certsDir: dir, logger });
    await second.initialize();
    expect(second.caPem()).toBe(pem);
  });

  it('emite certificado por host com SAN do alias .localhost', async () => {
    const manager = new CertificateManager({ certsDir: tempDir(), logger });
    const pair = await manager.ensureHost('api.uai.lsm');
    const leaf = new X509Certificate(pair.cert);
    const ca = new X509Certificate(manager.caPem() as string);

    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toContain('DNS:api.uai.lsm');
    expect(leaf.subjectAltName).toContain('DNS:api.uai.localhost');
    expect(pair.key).toContain('BEGIN PRIVATE KEY');
  });

  it('reutiliza o certificado do host e cria contexto TLS', async () => {
    const manager = new CertificateManager({ certsDir: tempDir(), logger });
    const first = await manager.ensureHost('app.lsm');
    const second = await manager.ensureHost('app.lsm');
    expect(second.cert).toBe(first.cert);

    const context = await manager.contextFor('app.lsm');
    expect(context).toBeDefined();
  });

  it('detecta CA confiável via certutil injetado', async () => {
    const calls: string[][] = [];
    let trusted = false;
    const manager = new CertificateManager({
      certsDir: tempDir(),
      logger,
      runCertutil: async (args) => {
        calls.push(args);
        if (args[0] === '-addstore') {
          trusted = true;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: trusted ? 0 : 1, stdout: '', stderr: '' };
      },
    });

    await manager.initialize();
    expect(await manager.isTrusted()).toBe(false);

    await manager.trust();
    expect(await manager.isTrusted()).toBe(true);
    expect(calls.some((args) => args.includes('Root'))).toBe(true);
  });

  it('rejeita CA com certificado corrompido e gera outra', async () => {
    const dir = tempDir();
    const manager = new CertificateManager({ certsDir: dir, logger });
    await manager.initialize();
    const original = manager.caPem();

    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(dir, 'ca.crt'), 'corrompido', 'utf8');

    const repaired = new CertificateManager({ certsDir: dir, logger });
    await repaired.initialize();
    expect(repaired.caPem()).not.toBe(original);
    expect(() => new X509Certificate(repaired.caPem() as string)).not.toThrow();
  });
});
