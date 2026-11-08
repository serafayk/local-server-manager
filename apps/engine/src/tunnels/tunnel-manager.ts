import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  LoggingConfig,
  LogRecord,
  TunnelConfig,
  TunnelHostname,
  TunnelState,
  TunnelStatus,
  TunnelSummary,
} from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, newId } from '@lsm/shared';
import { parseCreateTunnelRequest, parseUpdateTunnelRequest } from '@lsm/validation';
import type { EventBus } from '../core/event-bus';
import type { LogManager } from '../log-manager/log-manager';
import type { ProcessManager } from '../process-manager/process-manager';
import type { ManagedProcess } from '../process-manager/spawn-adapter';

const TUNNEL_LOGGING: LoggingConfig = {
  maxFileSizeMb: 10,
  retentionDays: 7,
  captureOutput: true,
  maskPatterns: [],
};

const METRICS_PORT_START = 20_241;
const METRICS_PORT_END = 20_260;
const READY_TIMEOUT_MS = 20_000;
const READY_INTERVAL_MS = 500;

export interface TunnelCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TunnelManagerDeps {
  repositories: Repositories;
  logManager: LogManager;
  processManager: ProcessManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  /** Injeção para testes; em produção usa `buildTunnelCommand`. */
  buildCommand?: (config: TunnelConfig, token: string | null) => TunnelCommand;
  /** Injeção para testes; em produção consulta `/ready`. */
  probeReady?: (metricsPort: number) => Promise<boolean>;
}

interface RuntimeEntry {
  config: TunnelConfig;
  status: TunnelStatus;
  instanceId: string | null;
  lastInstanceId: string | null;
  managed: ManagedProcess | null;
  stopping: boolean;
  output: string;
  hostnames: TunnelHostname[];
}

export function defaultTunnelConfigPath(): string {
  return join(homedir(), '.cloudflared', 'config.yml');
}

/** Extrai a URL efêmera de um quick tunnel da saída do cloudflared. */
export function parseQuickTunnelUrl(text: string): string | null {
  const match = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i.exec(text);
  return match ? match[0] : null;
}

/**
 * Lê `ingress[].hostname`/`service` de um config.yml do cloudflared.
 * Parser intencionalmente simples: só o bloco de ingress interessa.
 */
export function parseIngressHostnames(yaml: string): TunnelHostname[] {
  const result: TunnelHostname[] = [];
  let inIngress = false;
  let current: Partial<TunnelHostname> | null = null;

  const clean = (value: string): string =>
    value
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^['"]/, '')
      .replace(/['"]$/, '');

  const flush = (): void => {
    if (current?.hostname && current.service) {
      result.push({ hostname: current.hostname, service: current.service });
    }
    current = null;
  };

  for (const rawLine of yaml.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const line = rawLine.replace(/\s+#.*$/, '').replace(/\t/g, '  ');
    if (/^\s*ingress\s*:/.test(line)) {
      inIngress = true;
      continue;
    }
    if (!inIngress) {
      continue;
    }
    if (/^\S/.test(line)) {
      break; // próximo bloco de topo
    }

    const hostname = /^\s*-\s*hostname\s*:\s*(.+)$/.exec(line);
    if (hostname?.[1]) {
      flush();
      current = { hostname: clean(hostname[1]) };
      continue;
    }
    const service = /^\s*service\s*:\s*(.+)$/.exec(line);
    if (service?.[1] && current) {
      current.service = clean(service[1]);
    }
  }
  flush();
  return result;
}

export function buildTunnelCommand(config: TunnelConfig, token: string | null): TunnelCommand {
  const metrics = config.metricsPort ?? METRICS_PORT_START;
  const metricsArg = `127.0.0.1:${metrics}`;
  const executable = process.env.LSM_CLOUDFLARED?.trim() || 'cloudflared';
  const env: Record<string, string> = {};

  let args: string[];
  if (config.kind === 'config') {
    args = [
      'tunnel',
      '--config',
      config.configPath ?? defaultTunnelConfigPath(),
      '--metrics',
      metricsArg,
      'run',
    ];
  } else if (config.kind === 'token') {
    args = ['tunnel', '--metrics', metricsArg, 'run'];
    if (token !== null && token !== '') {
      // Variável de ambiente evita expor o token em argv e logs.
      env.TUNNEL_TOKEN = token;
    }
  } else {
    args = [
      'tunnel',
      '--url',
      `http://127.0.0.1:${config.targetPort ?? 80}`,
      '--metrics',
      metricsArg,
      '--no-autoupdate',
    ];
  }

  return {
    executable,
    args,
    cwd: config.configPath ? dirname(config.configPath) : homedir(),
    env,
  };
}

/**
 * Gerencia túneis do Cloudflare como processos independentes: start/stop,
 * logs, health via `/ready` e URL pública (quick tunnel).
 */
export class TunnelManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly buildCommand: (config: TunnelConfig, token: string | null) => TunnelCommand;
  private readonly probe: (metricsPort: number) => Promise<boolean>;

  constructor(private readonly deps: TunnelManagerDeps) {
    this.buildCommand = deps.buildCommand ?? buildTunnelCommand;
    this.probe = deps.probeReady ?? probeTunnelReady;
  }

  initialize(): void {
    for (const config of this.deps.repositories.tunnels.list()) {
      this.entries.set(config.id, this.createEntry(config));
    }
  }

  list(): TunnelSummary[] {
    return [...this.entries.values()]
      .map((entry) => ({ config: entry.config, status: entry.status }))
      .sort((a, b) => a.config.name.localeCompare(b.config.name));
  }

  get(id: string): TunnelSummary {
    const entry = this.resolve(id);
    return { config: entry.config, status: entry.status };
  }

  create(input: unknown): TunnelSummary {
    const data = parseCreateTunnelRequest(input);
    if (this.deps.repositories.tunnels.findByName(data.name)) {
      throw new AppError('TUNNEL_NAME_IN_USE', `Já existe um túnel com o nome "${data.name}"`);
    }

    const now = this.deps.clock.nowIso();
    const config: TunnelConfig = {
      id: newId(),
      name: data.name,
      kind: data.kind,
      configPath: data.configPath ?? null,
      targetPort: data.targetPort ?? null,
      projectId: data.projectId ?? null,
      enabled: data.enabled ?? true,
      startOnBoot: data.startOnBoot ?? false,
      metricsPort: this.allocateMetricsPort(),
      hasToken: typeof data.token === 'string' && data.token !== '',
      createdAt: now,
      updatedAt: now,
    };
    this.validateConfig(config, data.token ?? null);

    this.deps.repositories.tunnels.create(config, data.token ?? null);
    const entry = this.createEntry(config);
    this.entries.set(config.id, entry);
    this.deps.logger.info('Túnel cadastrado', { tunnelId: config.id, name: config.name });
    return { config: entry.config, status: entry.status };
  }

  update(id: string, input: unknown): TunnelSummary {
    const entry = this.resolve(id);
    if (entry.status.state !== 'STOPPED' && entry.status.state !== 'FAILED') {
      throw new AppError(
        'TUNNEL_ALREADY_RUNNING',
        `Pare o túnel "${entry.config.name}" antes de editar`,
      );
    }
    const data = parseUpdateTunnelRequest(input);
    const now = this.deps.clock.nowIso();
    const currentToken = this.deps.repositories.tunnels.findToken(id);

    let token: string | null | undefined;
    if (data.clearToken === true) {
      token = null;
    } else if (data.token !== undefined) {
      token = data.token;
    } else {
      token = undefined;
    }

    const config: TunnelConfig = {
      ...entry.config,
      name: data.name ?? entry.config.name,
      kind: data.kind ?? entry.config.kind,
      configPath: data.configPath !== undefined ? data.configPath : entry.config.configPath,
      targetPort: data.targetPort !== undefined ? data.targetPort : entry.config.targetPort,
      projectId: data.projectId !== undefined ? data.projectId : entry.config.projectId,
      enabled: data.enabled ?? entry.config.enabled,
      startOnBoot: data.startOnBoot ?? entry.config.startOnBoot,
      hasToken: token === undefined ? entry.config.hasToken : token !== null && token !== '',
      updatedAt: now,
    };

    if (data.name !== undefined) {
      const other = this.deps.repositories.tunnels.findByName(data.name);
      if (other && other.id !== id) {
        throw new AppError('TUNNEL_NAME_IN_USE', `Já existe um túnel com o nome "${data.name}"`);
      }
    }

    this.validateConfig(config, token === undefined ? currentToken : token);
    this.deps.repositories.tunnels.update(config, token);
    entry.config = config;
    entry.hostnames = this.readHostnames(config);
    entry.status = { ...entry.status, hostnames: entry.hostnames, updatedAt: now };
    this.emitState(entry);
    return { config: entry.config, status: entry.status };
  }

  remove(id: string): { id: string; name: string } {
    const entry = this.resolve(id);
    if (entry.status.state !== 'STOPPED' && entry.status.state !== 'FAILED') {
      throw new AppError(
        'TUNNEL_ALREADY_RUNNING',
        `Pare o túnel "${entry.config.name}" antes de remover`,
      );
    }
    this.deps.repositories.tunnels.delete(id);
    this.entries.delete(id);
    return { id, name: entry.config.name };
  }

  async start(id: string): Promise<TunnelStatus> {
    const entry = this.resolve(id);
    if (entry.status.state === 'RUNNING' || entry.status.state === 'STARTING') {
      throw new AppError(
        'TUNNEL_ALREADY_RUNNING',
        `Túnel "${entry.config.name}" já está em execução`,
      );
    }
    if (!entry.config.enabled) {
      throw new AppError('TUNNEL_INVALID_CONFIG', `Túnel "${entry.config.name}" está desabilitado`);
    }
    this.guardDuplicate(entry);
    this.validateConfig(entry.config, this.deps.repositories.tunnels.findToken(id));

    const instanceId = newId();
    entry.hostnames = this.readHostnames(entry.config);
    entry.instanceId = instanceId;
    entry.lastInstanceId = instanceId;
    entry.stopping = false;
    entry.output = '';
    entry.config = { ...entry.config };
    this.setState(entry, 'STARTING');
    this.deps.logManager.registerStream(id, instanceId, TUNNEL_LOGGING, 'tunnel.log');
    this.deps.logManager.recordSystem(
      id,
      instanceId,
      `túnel iniciado (kind=${entry.config.kind}, executável=${this.buildCommand(entry.config, null).executable})`,
    );

    let managed: ManagedProcess;
    try {
      managed = this.deps.processManager.spawn(
        this.buildCommand(entry.config, this.deps.repositories.tunnels.findToken(id)),
      );
    } catch (error) {
      this.setState(entry, 'FAILED', 'Falha ao iniciar o cloudflared');
      throw new AppError(
        'CLOUDFLARED_NOT_FOUND',
        'Não foi possível iniciar o cloudflared. Verifique se ele está no PATH.',
        undefined,
        { cause: error },
      );
    }

    entry.managed = managed;
    managed.onStdout((chunk) => this.consumeOutput(entry, instanceId, 'stdout', chunk));
    managed.onStderr((chunk) => this.consumeOutput(entry, instanceId, 'stderr', chunk));
    managed.onExit((info) => this.handleExit(entry, instanceId, info.code));
    managed.onError((error) => this.handleSpawnError(entry, instanceId, error));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      managed.onSpawn(finish);
      managed.onError(finish);
      const timer = setTimeout(finish, 10_000);
      timer.unref();
    });

    if (entry.instanceId !== instanceId || (entry.status.state as string) !== 'STARTING') {
      return entry.status;
    }

    entry.status = {
      ...entry.status,
      pid: managed.pid,
      startedAt: this.deps.clock.nowIso(),
      url: entry.config.kind === 'config' ? this.firstHttpsUrl(entry.hostnames) : null,
    };
    this.setState(entry, 'RUNNING');
    void this.monitorReady(entry, instanceId);
    return entry.status;
  }

  async stop(id: string): Promise<TunnelStatus> {
    const entry = this.resolve(id);
    if (entry.status.state === 'STOPPED' || entry.status.state === 'FAILED') {
      this.setState(entry, 'STOPPED');
      if (entry.lastInstanceId) {
        void this.deps.logManager.closeInstance(entry.lastInstanceId);
      }
      return entry.status;
    }
    const pid = entry.status.pid;
    entry.stopping = true;
    this.setState(entry, 'STOPPING');
    if (pid !== null) {
      await this.deps.processManager.stop(pid, { gracefulTimeoutMs: 5_000 });
    }
    entry.managed = null;
    entry.instanceId = null;
    entry.status = {
      ...entry.status,
      pid: null,
      url: entry.config.kind === 'config' ? this.firstHttpsUrl(entry.hostnames) : null,
      healthy: null,
      lastError: null,
      startedAt: null,
    };
    this.setState(entry, 'STOPPED');
    if (entry.lastInstanceId) {
      await this.deps.logManager.closeInstance(entry.lastInstanceId);
    }
    return entry.status;
  }

  async restart(id: string): Promise<TunnelStatus> {
    await this.stop(id);
    return this.start(id);
  }

  logs(id: string, limit = 200): LogRecord[] {
    const entry = this.resolve(id);
    if (!entry.lastInstanceId) {
      return [];
    }
    return this.deps.logManager.tail(id, entry.lastInstanceId, limit);
  }

  async startBootTunnels(): Promise<void> {
    for (const config of this.deps.repositories.tunnels.listBoot()) {
      try {
        await this.start(config.id);
      } catch (error) {
        this.deps.logger.warn(
          'Falha ao iniciar túnel marcado para boot',
          { tunnelId: config.id, name: config.name },
          error,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        await this.stop(entry.config.id);
      } catch (error) {
        this.deps.logger.warn(
          'Falha ao parar túnel durante shutdown',
          { tunnelId: entry.config.id },
          error,
        );
      }
    }
  }

  private createEntry(config: TunnelConfig): RuntimeEntry {
    const now = this.deps.clock.nowIso();
    const hostnames = this.readHostnames(config);
    return {
      config,
      status: {
        tunnelId: config.id,
        state: 'STOPPED',
        pid: null,
        url: config.kind === 'config' ? this.firstHttpsUrl(hostnames) : null,
        hostnames,
        healthy: null,
        lastError: null,
        startedAt: null,
        updatedAt: now,
      },
      instanceId: null,
      lastInstanceId: null,
      managed: null,
      stopping: false,
      output: '',
      hostnames,
    };
  }

  private resolve(id: string): RuntimeEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new AppError('TUNNEL_NOT_FOUND', `Túnel não encontrado: ${id}`);
    }
    return entry;
  }

  private validateConfig(config: TunnelConfig, token: string | null): void {
    if (config.kind === 'config') {
      const path = config.configPath ?? defaultTunnelConfigPath();
      if (!existsSync(path)) {
        throw new AppError('TUNNEL_INVALID_CONFIG', `config.yml não encontrado: ${path}`);
      }
      if (parseIngressHostnames(readFileSyncSafe(path)).length === 0) {
        throw new AppError(
          'TUNNEL_INVALID_CONFIG',
          `Nenhum hostname de ingress encontrado em ${path}`,
        );
      }
      return;
    }
    if (config.kind === 'token') {
      if (token === null || token === '') {
        throw new AppError('TUNNEL_INVALID_CONFIG', 'Túnel por token exige o token do Cloudflare');
      }
      return;
    }
    if (config.targetPort === null) {
      throw new AppError('TUNNEL_INVALID_CONFIG', 'Quick tunnel exige uma porta alvo');
    }
  }

  private readHostnames(config: TunnelConfig): TunnelHostname[] {
    if (config.kind !== 'config') {
      return [];
    }
    const path = config.configPath ?? defaultTunnelConfigPath();
    return parseIngressHostnames(readFileSyncSafe(path));
  }

  private firstHttpsUrl(hostnames: TunnelHostname[]): string | null {
    const first = hostnames[0]?.hostname;
    return first ? `https://${first}` : null;
  }

  private allocateMetricsPort(): number | null {
    const used = new Set(
      [...this.entries.values()]
        .map((entry) => entry.config.metricsPort)
        .filter((port): port is number => port !== null),
    );
    for (let port = METRICS_PORT_START; port <= METRICS_PORT_END; port += 1) {
      if (!used.has(port)) {
        return port;
      }
    }
    return null;
  }

  private guardDuplicate(entry: RuntimeEntry): void {
    for (const other of this.entries.values()) {
      if (other.config.id === entry.config.id) {
        continue;
      }
      if (other.status.state !== 'RUNNING' && other.status.state !== 'STARTING') {
        continue;
      }
      if (
        entry.config.kind === 'config' &&
        other.config.kind === 'config' &&
        entry.config.configPath === other.config.configPath
      ) {
        throw new AppError(
          'TUNNEL_ALREADY_RUNNING',
          `O túnel "${other.config.name}" já usa este config.yml`,
        );
      }
      if (
        entry.config.kind === 'quick' &&
        other.config.kind === 'quick' &&
        entry.config.targetPort === other.config.targetPort
      ) {
        throw new AppError(
          'TUNNEL_ALREADY_RUNNING',
          `Já existe um quick tunnel ativo para a porta ${entry.config.targetPort}`,
        );
      }
    }
  }

  private consumeOutput(
    entry: RuntimeEntry,
    instanceId: string,
    stream: 'stdout' | 'stderr',
    chunk: Buffer,
  ): void {
    this.deps.logManager.push(entry.config.id, instanceId, stream, chunk);
    if (entry.output.length < 16_000) {
      entry.output += chunk.toString('utf8');
    }
    if (entry.config.kind === 'quick' && entry.status.url === null) {
      const url = parseQuickTunnelUrl(entry.output);
      if (url !== null) {
        entry.status = { ...entry.status, url, updatedAt: this.deps.clock.nowIso() };
        this.emitState(entry);
        this.deps.events.emit('tunnel.url', { tunnelId: entry.config.id, url }, entry.config.id);
      }
    }
  }

  private handleExit(entry: RuntimeEntry, instanceId: string, code: number | null): void {
    if (entry.instanceId !== instanceId) {
      return;
    }
    if (entry.stopping) {
      entry.stopping = false;
      return;
    }
    const lastLine = entry.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .pop();
    entry.managed = null;
    entry.instanceId = null;
    entry.status = {
      ...entry.status,
      pid: null,
      healthy: null,
      startedAt: null,
      lastError: lastLine
        ? lastLine.slice(0, 300)
        : `cloudflared encerrou (code=${code ?? 'null'})`,
    };
    this.setState(entry, 'FAILED');
    if (entry.lastInstanceId) {
      void this.deps.logManager.closeInstance(entry.lastInstanceId).catch(() => undefined);
    }
  }

  private handleSpawnError(entry: RuntimeEntry, instanceId: string, error: Error): void {
    if (entry.instanceId !== instanceId) {
      return;
    }
    entry.managed = null;
    entry.instanceId = null;
    entry.status = {
      ...entry.status,
      pid: null,
      healthy: null,
      startedAt: null,
      lastError: error.message,
    };
    this.setState(entry, 'FAILED');
  }

  private async monitorReady(entry: RuntimeEntry, instanceId: string): Promise<void> {
    const metricsPort = entry.config.metricsPort;
    if (metricsPort === null) {
      return;
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (entry.instanceId !== instanceId || entry.status.state !== 'RUNNING') {
        return;
      }
      if (await this.probe(metricsPort)) {
        entry.status = { ...entry.status, healthy: true, updatedAt: this.deps.clock.nowIso() };
        this.emitState(entry);
        return;
      }
      await delay(READY_INTERVAL_MS);
    }
    if (entry.instanceId === instanceId && entry.status.state === 'RUNNING') {
      entry.status = { ...entry.status, healthy: false, updatedAt: this.deps.clock.nowIso() };
      this.emitState(entry);
    }
  }

  private setState(entry: RuntimeEntry, state: TunnelState, lastError?: string): void {
    entry.status = {
      ...entry.status,
      state,
      lastError: lastError ?? (state === 'FAILED' ? entry.status.lastError : null),
      updatedAt: this.deps.clock.nowIso(),
    };
    this.emitState(entry);
  }

  private emitState(entry: RuntimeEntry): void {
    this.deps.events.emit(
      'tunnel.state.changed',
      { tunnelId: entry.config.id, status: entry.status },
      entry.config.id,
    );
  }
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function probeTunnelReady(metricsPort: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`http://127.0.0.1:${metricsPort}/ready`, {
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
