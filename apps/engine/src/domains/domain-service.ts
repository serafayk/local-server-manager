import type { DomainRoute, DomainsOverview, DomainsStatus, HostsSyncResult } from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { DomainRecord } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, newId } from '@lsm/shared';
import {
  localhostAliasOf,
  parseCreateDomainRequest,
  parseUpdateDomainRequest,
} from '@lsm/validation';
import type { CertificateManager } from '../proxy/certificate-manager';
import type { HostsManager } from '../proxy/hosts-file';
import { ProxyManager, type ProxyPorts, type ProxyTarget } from '../proxy/proxy-manager';
import type { Supervisor } from '../supervisor/supervisor';

export const DOMAINS_SETTINGS_KEY = 'domains';
export const DEFAULT_DOMAIN_PORTS: ProxyPorts = { httpPort: 8_090, httpsPort: 8_443 };

export interface DomainServiceDeps {
  repositories: Repositories;
  supervisor: Supervisor;
  clock: Clock;
  logger: Logger;
  certificates: CertificateManager;
  hosts: HostsManager;
  /** Sobrescreve as portas persistidas (testes usam 0 = efêmera). */
  ports?: Partial<ProxyPorts>;
}

/**
 * Domínios locais: CRUD de rotas, CA/certificados e arquivo hosts.
 * O proxy só sobe quando há rota configurada ou quando a página pede.
 */
export class DomainService {
  private readonly proxy: ProxyManager;
  private starting: Promise<void> | null = null;
  private started = false;
  private proxyError: string | null = null;
  private activePorts: ProxyPorts;

  constructor(private readonly deps: DomainServiceDeps) {
    this.activePorts = { ...DEFAULT_DOMAIN_PORTS, ...deps.ports };
    this.proxy = new ProxyManager({
      logger: deps.logger,
      certificates: deps.certificates,
      resolve: (host) => this.resolveTarget(host),
    });
  }

  get ports(): ProxyPorts {
    return this.activePorts;
  }

  /** Sobe o proxy se ainda não estiver ativo (idempotente e concorrente-seguro). */
  ensureStarted(): Promise<void> {
    if (this.started) {
      return Promise.resolve();
    }
    if (this.starting !== null) {
      return this.starting;
    }
    this.starting = this.startProxy().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async startIfConfigured(): Promise<void> {
    if (this.deps.repositories.domains.list().length > 0) {
      await this.ensureStarted().catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    await this.proxy.stop();
    this.started = false;
  }

  list(): DomainRoute[] {
    const managed = new Set(this.deps.hosts.managedHosts());
    return this.deps.repositories.domains.list().map((record) => {
      const project = this.deps.repositories.projects.findById(record.projectId);
      const snapshot = project ? this.deps.supervisor.getSnapshotById(project.id) : null;
      const host = record.host;
      const alias = localhostAliasOf(host);
      return {
        id: record.id,
        host,
        projectId: record.projectId,
        projectName: project?.name ?? '(projeto removido)',
        projectStatus: snapshot?.status ?? 'STOPPED',
        port: record.port,
        upstreamPort: record.port ?? project?.port ?? null,
        urls: {
          http: `http://${host}:${this.activePorts.httpPort}`,
          https: `https://${host}:${this.activePorts.httpsPort}`,
          localhost: `http://${alias}:${this.activePorts.httpPort}`,
        },
        hostsSynced: host.endsWith('.lsm') ? managed.has(host) : true,
      };
    });
  }

  async overview(): Promise<DomainsOverview> {
    try {
      await this.ensureStarted();
    } catch {
      // O status abaixo carrega o motivo; a página continua utilizável.
    }
    return { routes: this.list(), status: await this.status() };
  }

  async status(): Promise<DomainsStatus> {
    const certificate = await this.deps.certificates.status();
    return {
      httpPort: this.activePorts.httpPort,
      httpsPort: this.activePorts.httpsPort,
      httpListening: this.proxy.listening.http,
      httpsListening: this.proxy.listening.https,
      certificate,
      hostsFile: this.deps.hosts.path,
      pendingHosts: this.deps.hosts.pending(this.desiredHosts()),
      proxyError: this.proxyError,
    };
  }

  async create(input: unknown): Promise<DomainRoute> {
    const data = parseCreateDomainRequest(input);
    const project =
      this.deps.repositories.projects.findById(data.projectId) ??
      this.deps.repositories.projects.findByName(data.projectId);
    if (!project) {
      throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${data.projectId}`);
    }
    this.assertHostFree(data.host, null);

    const now = this.deps.clock.nowIso();
    const record = {
      id: newId(),
      host: data.host,
      projectId: project.id,
      port: data.port ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repositories.domains.create(record);
    void this.deps.certificates.ensureHost(record.host).catch((error: unknown) => {
      this.deps.logger.warn('Falha ao preparar certificado do domínio', {}, error);
    });
    void this.ensureStarted().catch(() => undefined);

    this.deps.repositories.events.append({
      projectId: project.id,
      instanceId: null,
      level: 'info',
      eventType: 'domain.created',
      message: `domínio "${record.host}" criado`,
      metadata: { host: record.host, projectId: project.id, port: record.port },
    });
    return this.get(record.id);
  }

  async update(id: string, input: unknown): Promise<DomainRoute> {
    const existing = this.deps.repositories.domains.findById(id);
    if (!existing) {
      throw new AppError('DOMAIN_NOT_FOUND', `Domínio não encontrado: ${id}`);
    }
    const patch = parseUpdateDomainRequest(input);
    const host = patch.host ?? existing.host;
    if (patch.host !== undefined && patch.host !== existing.host) {
      this.assertHostFree(host, id);
    }

    const record = {
      ...existing,
      host,
      port: patch.port === undefined ? existing.port : patch.port,
      updatedAt: this.deps.clock.nowIso(),
    };
    this.deps.repositories.domains.update(record);
    if (record.host !== existing.host) {
      void this.deps.certificates.ensureHost(record.host).catch((error: unknown) => {
        this.deps.logger.warn('Falha ao preparar certificado do domínio', {}, error);
      });
      this.deps.repositories.events.append({
        projectId: record.projectId,
        instanceId: null,
        level: 'info',
        eventType: 'domain.updated',
        message: `domínio alterado de "${existing.host}" para "${record.host}"`,
        metadata: { from: existing.host, to: record.host },
      });
    }
    return this.get(record.id);
  }

  delete(id: string): { id: string; host: string } {
    const existing = this.deps.repositories.domains.findById(id);
    if (!existing) {
      throw new AppError('DOMAIN_NOT_FOUND', `Domínio não encontrado: ${id}`);
    }
    this.deps.repositories.domains.delete(id);
    this.deps.repositories.events.append({
      projectId: existing.projectId,
      instanceId: null,
      level: 'warn',
      eventType: 'domain.deleted',
      message: `domínio "${existing.host}" removido`,
      metadata: { host: existing.host },
    });
    return { id: existing.id, host: existing.host };
  }

  /** Sincroniza em lote os hosts `.lsm` (um único prompt de UAC). */
  async syncHosts(): Promise<HostsSyncResult> {
    const desired = this.desiredHosts();
    const outcome = await this.deps.hosts.sync(desired);
    if (!outcome.ok) {
      this.deps.logger.warn('Sincronização do arquivo hosts falhou', {
        error: outcome.error,
        pending: outcome.pending.length,
      });
    }
    return { applied: outcome.applied, pending: outcome.pending, error: outcome.error };
  }

  async trustCa(): Promise<void> {
    await this.deps.certificates.initialize();
    await this.deps.certificates.trust();
    await this.prepareCertificates();
  }

  caPem(): string {
    const pem = this.deps.certificates.caPem();
    if (pem === null) {
      throw new AppError('CERTIFICATE_ERROR', 'A CA local ainda não foi criada');
    }
    return pem;
  }

  /** Usado pelo proxy: resolve o destino de um Host (inclui alias `.localhost`). */
  resolveTarget(host: string): ProxyTarget | null {
    const record = this.findRecord(host);
    if (!record) {
      return null;
    }
    const project = this.deps.repositories.projects.findById(record.projectId);
    if (!project) {
      return null;
    }
    const snapshot = this.deps.supervisor.getSnapshotById(project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      status: snapshot?.status ?? 'STOPPED',
      port: record.port ?? project.port,
    };
  }

  private findRecord(host: string): DomainRecord | null {
    const direct = this.deps.repositories.domains.findByHost(host);
    if (direct) {
      return direct;
    }
    if (host.endsWith('.localhost')) {
      const lsm = `${host.slice(0, -'.localhost'.length)}.lsm`;
      return this.deps.repositories.domains.findByHost(lsm);
    }
    return null;
  }

  private desiredHosts(): string[] {
    return this.deps.repositories.domains
      .list()
      .map((record) => record.host)
      .filter((host) => host.endsWith('.lsm'));
  }

  /** Impede que dois domínios disputem o mesmo host ou alias `.localhost`. */
  private assertHostFree(host: string, excludeId: string | null): void {
    const alias = localhostAliasOf(host);
    for (const record of this.deps.repositories.domains.list()) {
      if (record.id === excludeId) {
        continue;
      }
      const otherAlias = localhostAliasOf(record.host);
      if (
        record.host === host ||
        record.host === alias ||
        otherAlias === host ||
        otherAlias === alias
      ) {
        throw new AppError(
          'DOMAIN_HOST_IN_USE',
          `"${host}" conflita com o domínio existente "${record.host}"`,
        );
      }
    }
  }

  private async startProxy(): Promise<void> {
    const stored = this.deps.repositories.settings.get<Partial<ProxyPorts>>(DOMAINS_SETTINGS_KEY);
    this.activePorts = {
      ...DEFAULT_DOMAIN_PORTS,
      ...(stored ?? {}),
      ...this.deps.ports,
    };
    await this.deps.certificates.initialize();
    try {
      const actual = await this.proxy.start(this.activePorts);
      this.activePorts = actual;
      this.proxyError = null;
      this.started = true;
      this.persistPorts(actual);
      await this.prepareCertificates();
    } catch (error) {
      this.proxyError = error instanceof Error ? error.message : String(error);
      this.deps.logger.error('Não foi possível iniciar o proxy de domínios', {
        error: this.proxyError,
      });
      throw new AppError(
        'DOMAIN_PROXY_UNAVAILABLE',
        `Proxy de domínios indisponível: ${this.proxyError}`,
        undefined,
        { cause: error },
      );
    }
  }

  private async prepareCertificates(): Promise<void> {
    for (const record of this.deps.repositories.domains.list()) {
      await this.deps.certificates.ensureHost(record.host).catch((error: unknown) => {
        this.deps.logger.warn(
          'Falha ao gerar certificado do domínio',
          { host: record.host },
          error,
        );
      });
    }
  }

  private persistPorts(ports: ProxyPorts): void {
    this.deps.repositories.settings.set(
      DOMAINS_SETTINGS_KEY,
      { httpPort: ports.httpPort, httpsPort: ports.httpsPort },
      this.deps.clock.nowIso(),
    );
  }

  private get(id: string): DomainRoute {
    const routes = this.list();
    const route = routes.find((item) => item.id === id);
    if (!route) {
      throw new AppError('DOMAIN_NOT_FOUND', `Domínio não encontrado: ${id}`);
    }
    return route;
  }
}
