import { createHash, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { generate } from 'selfsigned';
import type { DomainCertificateStatus } from '@lsm/contracts';
import type { Logger } from '@lsm/shared';
import { AppError } from '@lsm/shared';
import { localhostAliasOf } from '@lsm/validation';

const CA_COMMON_NAME = 'Local Server Manager Local CA';
const CA_VALIDITY_DAYS = 3_650;
const LEAF_VALIDITY_DAYS = 730;
const MIN_REMAINING_MS = 7 * 24 * 60 * 60 * 1_000;

export interface CertificateManagerOptions {
  certsDir: string;
  logger: Logger;
  now?: () => number;
  runCertutil?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Instala a CA; separado porque o Windows exige confirmação visível. */
  runTrust?: (derFile: string) => Promise<{ code: number; stderr: string }>;
  trustTimeoutMs?: number;
}

export interface CertificatePair {
  key: string;
  cert: string;
}

/**
 * CA local + certificados por host. A CA fica no armazenamento do usuário
 * (CurrentUser\Root), então confiar nela não exige UAC.
 */
export class CertificateManager {
  private readonly caKeyFile: string;
  private readonly caCertFile: string;
  private readonly caDerFile: string;
  private readonly hostsDir: string;
  private readonly now: () => number;
  private readonly runCertutil: NonNullable<CertificateManagerOptions['runCertutil']>;
  private readonly runTrust: NonNullable<CertificateManagerOptions['runTrust']>;
  private readonly trustTimeoutMs: number;
  private ca: CertificatePair | null = null;
  private readonly contexts = new Map<string, SecureContext>();

  constructor(private readonly options: CertificateManagerOptions) {
    this.caKeyFile = join(options.certsDir, 'ca.key');
    this.caCertFile = join(options.certsDir, 'ca.crt');
    this.caDerFile = join(options.certsDir, 'ca.cer');
    this.hostsDir = join(options.certsDir, 'hosts');
    this.now = options.now ?? (() => Date.now());
    this.runCertutil = options.runCertutil ?? runCertutilProcess;
    this.runTrust =
      options.runTrust ?? ((file) => runTrustWithPrompt(file, options.trustTimeoutMs ?? 90_000));
    this.trustTimeoutMs = options.trustTimeoutMs ?? 90_000;
  }

  get caPath(): string {
    return this.caCertFile;
  }

  /** Cria a CA na primeira execução (10 anos, RSA 2048). */
  async initialize(): Promise<void> {
    await this.ensureCa();
    mkdirSync(this.hostsDir, { recursive: true });
  }

  async ensureCa(): Promise<CertificatePair> {
    if (this.ca) {
      return this.ca;
    }
    if (existsSync(this.caKeyFile) && existsSync(this.caCertFile)) {
      const pair = {
        key: readFileSync(this.caKeyFile, 'utf8'),
        cert: readFileSync(this.caCertFile, 'utf8'),
      };
      try {
        const parsed = new X509Certificate(pair.cert);
        if (new Date(parsed.validTo).getTime() > this.now() + MIN_REMAINING_MS) {
          this.ca = pair;
          return pair;
        }
        this.options.logger.warn('CA local expirada; gerando uma nova');
      } catch {
        this.options.logger.warn('CA local inválida; gerando uma nova');
      }
    }

    mkdirSync(dirname(this.caKeyFile), { recursive: true });
    const generated = await generate(
      [
        { name: 'commonName', value: CA_COMMON_NAME },
        { name: 'organizationName', value: 'Local Server Manager' },
      ],
      {
        keySize: 2048,
        algorithm: 'sha256',
        notAfterDate: new Date(this.now() + CA_VALIDITY_DAYS * 24 * 60 * 60 * 1_000),
        extensions: [
          { name: 'basicConstraints', cA: true, critical: true },
          { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        ],
      },
    );

    const pair = { key: generated.private, cert: generated.cert };
    writeFileSync(this.caKeyFile, pair.key, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(this.caCertFile, pair.cert, 'utf8');
    writeFileSync(this.caDerFile, pemToDer(pair.cert));
    this.ca = pair;
    this.contexts.clear();
    this.options.logger.info('CA local criada', { path: this.caCertFile });
    return pair;
  }

  caPem(): string | null {
    try {
      return readFileSync(this.caCertFile, 'utf8');
    } catch {
      return null;
    }
  }

  /** Certificado do host, reutilizado enquanto válido e emitido pela CA. */
  async ensureHost(host: string): Promise<CertificatePair> {
    const normalized = host.toLowerCase();
    const certFile = join(this.hostsDir, `${normalized}.crt`);
    const keyFile = join(this.hostsDir, `${normalized}.key`);

    if (existsSync(certFile) && existsSync(keyFile)) {
      const pair = { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
      if (await this.isUsable(normalized, pair)) {
        return pair;
      }
    }

    const ca = await this.ensureCa();
    const alias = localhostAliasOf(normalized);
    const altNames = [...new Set([normalized, alias])].map((name) => ({
      type: 2 as const,
      value: name,
    }));

    const generated = await generate([{ name: 'commonName', value: normalized }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(this.now() + LEAF_VALIDITY_DAYS * 24 * 60 * 60 * 1_000),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
      ca: { key: ca.key, cert: ca.cert },
    });

    const pair = { key: generated.private, cert: generated.cert };
    mkdirSync(this.hostsDir, { recursive: true });
    writeFileSync(certFile, pair.cert, 'utf8');
    writeFileSync(keyFile, pair.key, { encoding: 'utf8', mode: 0o600 });
    this.contexts.delete(normalized);
    return pair;
  }

  /** Contexto TLS para SNI (cria o certificado sob demanda). */
  async contextFor(host: string): Promise<SecureContext> {
    const normalized = host.toLowerCase();
    const cached = this.contexts.get(normalized);
    if (cached) {
      return cached;
    }
    const pair = await this.ensureHost(normalized);
    const context = createSecureContext({ key: pair.key, cert: pair.cert });
    this.contexts.set(normalized, context);
    return context;
  }

  /** Certificado padrão (sem SNI): localhost. */
  async defaultPair(): Promise<CertificatePair> {
    return this.ensureHost('localhost');
  }

  async status(): Promise<DomainCertificateStatus> {
    if (!existsSync(this.caCertFile)) {
      return { exists: false, trusted: false, path: null };
    }
    return {
      exists: true,
      trusted: await this.isTrusted(),
      path: this.caCertFile,
    };
  }

  /** Instala a CA no repositório do usuário (Windows pede confirmação visual). */
  async trust(): Promise<void> {
    await this.ensureCa();
    if (!existsSync(this.caDerFile)) {
      writeFileSync(this.caDerFile, pemToDer(readFileSync(this.caCertFile, 'utf8')));
    }
    const result = await this.runTrust(this.caDerFile);
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      const timedOut = /tempo esgotado/i.test(detail) || result.code === 124;
      throw new AppError(
        'CERTIFICATE_ERROR',
        timedOut
          ? `A confirmação do Windows não apareceu em ${Math.round(this.trustTimeoutMs / 1_000)}s. Clique em "Confiar na CA" novamente e aceite o aviso de segurança.`
          : `Não foi possível confiar na CA local: ${detail || 'cancelado'}`,
      );
    }
    if (!(await this.isTrusted())) {
      throw new AppError('CERTIFICATE_ERROR', 'O Windows não confirmou a instalação da CA local');
    }
    this.options.logger.info('CA local confiada no repositório do usuário');
  }

  async untrust(): Promise<void> {
    if (!existsSync(this.caCertFile)) {
      return;
    }
    const fingerprint = fingerprintOf(readFileSync(this.caCertFile, 'utf8'));
    await this.runCertutil(['-delstore', '-user', 'Root', fingerprint]);
  }

  async isTrusted(): Promise<boolean> {
    if (!existsSync(this.caCertFile)) {
      return false;
    }
    const fingerprint = fingerprintOf(readFileSync(this.caCertFile, 'utf8'));
    const result = await this.runCertutil(['-store', '-user', 'Root', fingerprint]);
    return result.code === 0;
  }

  private async isUsable(host: string, pair: CertificatePair): Promise<boolean> {
    try {
      const leaf = new X509Certificate(pair.cert);
      if (new Date(leaf.validTo).getTime() <= this.now() + MIN_REMAINING_MS) {
        return false;
      }
      if (!leaf.subjectAltName?.includes(`DNS:${host}`)) {
        return false;
      }
      const ca = await this.ensureCa();
      return leaf.checkIssued(new X509Certificate(ca.cert));
    } catch {
      return false;
    }
  }
}

/** DER do certificado (formato aceito pelo certutil). */
function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}

function fingerprintOf(pem: string): string {
  return createHash('sha1').update(pemToDer(pem)).digest('hex').toUpperCase();
}

function runCertutilProcess(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('certutil.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolvePromise({ code: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Instala a CA com a janela de confirmação do Windows visível.
 *
 * `certutil -addstore` abre o "Aviso de Segurança" ao gravar em Root; rodar com
 * a janela oculta deixaria o processo pendurado para sempre. O PowerShell faz
 * `Start-Process` sem esconder a janela e aplica timeout.
 */
function runTrustWithPrompt(
  derFile: string,
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  const escaped = derFile.replace(/'/g, "''");
  const script = [
    `$p = Start-Process -FilePath 'certutil.exe'`,
    `-ArgumentList @('-addstore','-user','Root','${escaped}')`,
    `-Wait -PassThru; exit $p.ExitCode`,
  ].join(' ');

  return new Promise((resolvePromise) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: false },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: 124, stderr: 'Tempo esgotado aguardando confirmação do Windows.' });
    }, timeoutMs);
    timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stderr });
    });
  });
}
