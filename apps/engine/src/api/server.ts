import { basename } from 'node:path';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type {
  DetectProjectResponse,
  EngineApiInfo,
  EngineInfo,
  EngineSettings,
  RuntimeConfig,
} from '@lsm/contracts';
import { ERROR_HTTP_STATUS, PROTOCOL_VERSION } from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import {
  detectDocker,
  detectNodeInstallations,
  detectPostgresInstallations,
  inspectProjectDirectory,
  resolvePackageManagerInvocation,
  scanProjectRoot,
} from '@lsm/platform-win';
import { AppError, isAppError } from '@lsm/shared';
import type { Clock, Logger } from '@lsm/shared';
import {
  parseBulkProjectsRequest,
  parseDetectProjectRequest,
  parseImportProjectRequest,
  parseRestoreBackupRequest,
  parseScanRootRequest,
} from '@lsm/validation';
import type { EventBus } from '../core/event-bus';
import { runWithConcurrency } from '../core/concurrency';
import type { BackupManager } from '../backup/backup-manager';
import type { LogManager } from '../log-manager/log-manager';
import type { MetricsCollector } from '../metrics/metrics-collector';
import { checkPort } from '../ports/port-checker';
import type { ProjectService } from '../supervisor/project-service';
import type { GroupService } from '../supervisor/group-service';
import type { StackService } from '../supervisor/stack-service';
import type { Supervisor } from '../supervisor/supervisor';
import type { DomainService } from '../domains/domain-service';
import type { TunnelManager } from '../tunnels/tunnel-manager';
import { extractBearerToken, extractQueryToken, tokensMatch } from './auth';
import { WebAuth } from './web-auth';
import type { WebHosts } from './web-hosts';
import {
  isAllowedHostHeader,
  isAllowedOrigin,
  isLoopbackHost,
  parsePositiveInt,
  requestIdOf,
  sendFailure,
  sendSuccess,
  splitHost,
} from './http';
import { WebSocketGateway, type WebSocketLike } from './websocket-gateway';

const MAX_BODY_BYTES = 1_048_576;

export interface ApiServerOptions {
  token: string;
  supervisor: Supervisor;
  stacks: StackService;
  projects: ProjectService;
  groups: GroupService;
  domains: DomainService;
  tunnels: TunnelManager;
  repositories: Repositories;
  logManager: LogManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  metrics: MetricsCollector;
  backups: BackupManager;
  webAuth: WebAuth;
  webHosts: WebHosts;
  /** Diretório da UI web (null desabilita a hospedagem). */
  webDir: string | null;
  /** Porta preferida da API (0 = efêmera). Com Web UI, use uma fixa. */
  preferredPort?: number;
  engineInfo: () => EngineInfo;
  getSettings: () => EngineSettings;
  updateSettings: (input: unknown) => EngineSettings;
  corsOrigins?: readonly string[];
  heartbeatIntervalMs?: number;
}

export interface ApiServer {
  start(): Promise<EngineApiInfo>;
  stop(): Promise<void>;
  readonly info: EngineApiInfo | null;
}

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];

function projectIdOf(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== 'string' || params.id.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'id do projeto ausente');
  }
  return params.id;
}

function queryOf(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

const WEB_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

function safeStatSync(path: string): Stats | null {
  try {
    return statSync(path) as Stats;
  } catch {
    return null;
  }
}

/**
 * Com Web UI a porta é fixa (bookmark estável); se estiver ocupada, tenta as
 * seguintes. Porta 0 continua efêmera para testes e para o desktop sem UI.
 */
async function listenWithFallback(instance: FastifyInstance, preferred: number): Promise<void> {
  if (preferred === 0) {
    await instance.listen({ host: '127.0.0.1', port: 0 });
    return;
  }
  let lastError: unknown = null;
  for (let offset = 0; offset < 10; offset += 1) {
    try {
      await instance.listen({ host: '127.0.0.1', port: preferred + offset });
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('Nenhuma porta disponível para a API local');
}

/**
 * API local privada: bind apenas em 127.0.0.1, token por execução,
 * validação de Host (DNS rebinding) e envelope único.
 */
export function createApiServer(options: ApiServerOptions): ApiServer {
  const corsOrigins = options.corsOrigins ?? DEFAULT_CORS_ORIGINS;
  let app: FastifyInstance | null = null;
  let gateway: WebSocketGateway | null = null;
  let info: EngineApiInfo | null = null;
  let boundPort = 0;

  const registerRoutes = (instance: FastifyInstance): void => {
    instance.get('/api/v1/auth/status', async (request, reply) => {
      return sendSuccess(
        reply,
        options.webAuth.status(request.headers.cookie),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/auth/setup', async (request, reply) => {
      // Primeiro acesso (definir senha) só por loopback: evita que alguém
      // alcance a API por DNS rebinding e sequestre o painel antes do dono.
      if (!isLoopbackHost(request.headers.host)) {
        return sendFailure(
          reply,
          {
            code: 'UNAUTHORIZED',
            message: 'Defina a senha acessando o painel por 127.0.0.1.',
          },
          requestIdOf(request),
          403,
        );
      }
      if (options.webAuth.isConfigured()) {
        return sendFailure(
          reply,
          { code: 'VALIDATION_ERROR', message: 'A senha da Web UI já está configurada' },
          requestIdOf(request),
          409,
        );
      }
      const body = request.body as { password?: unknown } | null;
      const password = typeof body?.password === 'string' ? body.password : '';
      try {
        options.webAuth.setPassword(password);
      } catch (error) {
        return sendFailure(
          reply,
          {
            code: 'VALIDATION_ERROR',
            message: error instanceof Error ? error.message : 'Senha inválida',
          },
          requestIdOf(request),
          400,
        );
      }
      const session = options.webAuth.createSession();
      reply.header('set-cookie', [
        WebAuth.sessionCookie(session.sessionId),
        WebAuth.csrfCookie(session.csrf),
      ]);
      return sendSuccess(
        reply,
        { configured: true, authenticated: true, csrf: session.csrf },
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/auth/login', async (request, reply) => {
      const body = request.body as { password?: unknown } | null;
      const password = typeof body?.password === 'string' ? body.password : '';
      const result = options.webAuth.login(request.ip, password);
      if (!result.ok || result.sessionId === null || result.csrf === null) {
        return sendFailure(
          reply,
          { code: 'UNAUTHORIZED', message: result.error ?? 'Falha no login' },
          requestIdOf(request),
          /muitas tentativas/i.test(result.error ?? '') ? 429 : 401,
        );
      }
      reply.header('set-cookie', [
        WebAuth.sessionCookie(result.sessionId),
        WebAuth.csrfCookie(result.csrf),
      ]);
      return sendSuccess(
        reply,
        { configured: true, authenticated: true, csrf: result.csrf },
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/auth/logout', async (request, reply) => {
      options.webAuth.destroy(options.webAuth.sessionIdFrom(request.headers.cookie));
      reply.header('set-cookie', WebAuth.clearCookies());
      return sendSuccess(
        reply,
        { configured: options.webAuth.isConfigured(), authenticated: false, csrf: null },
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/web-hosts', async (request, reply) => {
      const parsed = splitHost(request.headers.host);
      return sendSuccess(
        reply,
        {
          hosts: [...options.webHosts.list()],
          currentHost: parsed?.hostname ?? '',
          loopback: isLoopbackHost(request.headers.host),
        },
        requestIdOf(request),
      );
    });

    instance.put('/api/v1/web-hosts', async (request, reply) => {
      const body = request.body as { hosts?: unknown } | null;
      try {
        const hosts = options.webHosts.replace(body?.hosts);
        const parsed = splitHost(request.headers.host);
        return sendSuccess(
          reply,
          {
            hosts,
            currentHost: parsed?.hostname ?? '',
            loopback: isLoopbackHost(request.headers.host),
          },
          requestIdOf(request),
        );
      } catch (error) {
        if (!isAppError(error)) {
          throw error;
        }
        return sendFailure(
          reply,
          { code: error.code, message: error.message },
          requestIdOf(request),
          400,
        );
      }
    });

    instance.get('/api/v1/health', async (request, reply) => {
      const engine = options.engineInfo();
      return sendSuccess(
        reply,
        {
          status: 'ok',
          pid: engine.pid,
          startedAt: engine.startedAt,
          uptimeMs: Math.max(0, options.clock.nowMs() - Date.parse(engine.startedAt)),
          projects: engine.projects,
        },
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/info', async (request, reply) => {
      return sendSuccess(reply, options.engineInfo(), requestIdOf(request));
    });

    instance.get('/api/v1/projects', async (request, reply) => {
      return sendSuccess(reply, options.projects.listProjects(), requestIdOf(request));
    });

    instance.post('/api/v1/projects', async (request, reply) => {
      const created = options.projects.createProject(request.body);
      return sendSuccess(reply, created, requestIdOf(request), 201);
    });

    instance.post('/api/v1/projects/detect', async (request, reply) => {
      const body = parseDetectProjectRequest(request.body);
      const inspection = inspectProjectDirectory(body.directory);
      const response: DetectProjectResponse = {
        directory: inspection.directory,
        hasPackageJson: inspection.hasPackageJson,
        projectName: inspection.projectName,
        scripts: inspection.scripts,
        packageManager: inspection.packageManager.packageManager,
        lockfile: inspection.packageManager.lockfile,
        packageManagerConfirmed: inspection.packageManager.confirmed,
      };
      return sendSuccess(reply, response, requestIdOf(request));
    });

    instance.post('/api/v1/projects/scan-root', async (request, reply) => {
      const body = parseScanRootRequest(request.body);
      return sendSuccess(reply, scanProjectRoot(body.directory), requestIdOf(request));
    });

    instance.post('/api/v1/projects/import', async (request, reply) => {
      const body = parseImportProjectRequest(request.body);
      const inspection = inspectProjectDirectory(body.directory);

      let runtime: RuntimeConfig;
      if (body.executable !== undefined) {
        runtime = { executable: body.executable, args: body.args ?? [] };
      } else if (body.script !== undefined) {
        const invocation = resolvePackageManagerInvocation(
          body.packageManager ?? inspection.packageManager.packageManager,
          body.script,
          { cwd: body.directory },
        );
        runtime = { executable: invocation.executable, args: invocation.args };
      } else {
        throw new AppError(
          'VALIDATION_ERROR',
          'Informe "script" (package manager) ou "executable" para importar.',
        );
      }

      const name = body.name ?? inspection.projectName ?? basename(body.directory);
      const created = options.projects.createProject({
        name,
        workingDirectory: body.directory,
        runtime,
        environment: body.environment ?? {},
        groupId: body.groupId ?? null,
        port: body.port ?? null,
        portSource: body.port !== null && body.port !== undefined ? 'fixed' : 'none',
        startOnBoot: body.startOnBoot ?? false,
        enabled: body.enabled ?? true,
        startupOrder: body.startupOrder ?? 0,
        ...(body.restartPolicy !== undefined ? { restartPolicy: body.restartPolicy } : {}),
        ...(body.healthCheck !== undefined ? { healthCheck: body.healthCheck } : {}),
        ...(body.logging !== undefined ? { logging: body.logging } : {}),
        ...(body.shutdown !== undefined ? { shutdown: body.shutdown } : {}),
      });
      return sendSuccess(reply, created, requestIdOf(request), 201);
    });

    instance.get('/api/v1/projects/:id/launch-preview', async (request, reply) => {
      return sendSuccess(
        reply,
        options.projects.launchPreview(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/projects/:id/build', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.projects.buildProject(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/projects/export', async (request, reply) => {
      return sendSuccess(reply, options.projects.exportConfiguration(), requestIdOf(request));
    });

    instance.post('/api/v1/projects/import-config', async (request, reply) => {
      return sendSuccess(
        reply,
        options.projects.importConfiguration(request.body),
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/groups', async (request, reply) => {
      return sendSuccess(reply, options.groups.list(), requestIdOf(request));
    });
    instance.post('/api/v1/groups', async (request, reply) => {
      return sendSuccess(reply, options.groups.create(request.body), requestIdOf(request), 201);
    });

    instance.put('/api/v1/groups/:id', async (request, reply) => {
      return sendSuccess(
        reply,
        options.groups.update(projectIdOf(request), request.body),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/groups/:id/start', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.stacks.startGroup(projectIdOf(request), 'USER'),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/groups/:id/stop', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.stacks.stopGroup(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/groups/:id/restart', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.stacks.restartGroup(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.delete('/api/v1/groups/:id', async (request, reply) => {
      return sendSuccess(reply, options.groups.delete(projectIdOf(request)), requestIdOf(request));
    });

    instance.get('/api/v1/domains', async (request, reply) => {
      return sendSuccess(reply, await options.domains.overview(), requestIdOf(request));
    });

    instance.post('/api/v1/domains', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.domains.create(request.body),
        requestIdOf(request),
        201,
      );
    });

    instance.post('/api/v1/domains/hosts/sync', async (_request, reply) => {
      return sendSuccess(reply, await options.domains.syncHosts(), requestIdOf(_request));
    });

    instance.post('/api/v1/domains/ca/trust', async (request, reply) => {
      await options.domains.trustCa();
      return sendSuccess(reply, await options.domains.status(), requestIdOf(request));
    });

    instance.get('/api/v1/domains/ca', async (_request, reply) => {
      reply.type('application/x-pem-file');
      return options.domains.caPem();
    });

    instance.put('/api/v1/domains/:id', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.domains.update(projectIdOf(request), request.body),
        requestIdOf(request),
      );
    });

    instance.delete('/api/v1/domains/:id', async (request, reply) => {
      return sendSuccess(reply, options.domains.delete(projectIdOf(request)), requestIdOf(request));
    });

    instance.get('/api/v1/tunnels', async (request, reply) => {
      return sendSuccess(reply, options.tunnels.list(), requestIdOf(request));
    });

    instance.post('/api/v1/tunnels', async (request, reply) => {
      return sendSuccess(reply, options.tunnels.create(request.body), requestIdOf(request), 201);
    });

    instance.get('/api/v1/tunnels/:id', async (request, reply) => {
      return sendSuccess(reply, options.tunnels.get(projectIdOf(request)), requestIdOf(request));
    });

    instance.put('/api/v1/tunnels/:id', async (request, reply) => {
      return sendSuccess(
        reply,
        options.tunnels.update(projectIdOf(request), request.body),
        requestIdOf(request),
      );
    });

    instance.delete('/api/v1/tunnels/:id', async (request, reply) => {
      return sendSuccess(reply, options.tunnels.remove(projectIdOf(request)), requestIdOf(request));
    });

    instance.post('/api/v1/tunnels/:id/start', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.tunnels.start(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/tunnels/:id/stop', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.tunnels.stop(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/tunnels/:id/restart', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.tunnels.restart(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/tunnels/:id/logs', async (request, reply) => {
      const tail = parsePositiveInt(queryOf(request).tail, 200, 1, 5_000);
      return sendSuccess(
        reply,
        { records: options.tunnels.logs(projectIdOf(request), tail) },
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/system/node-versions', async (request, reply) => {
      return sendSuccess(reply, detectNodeInstallations(), requestIdOf(request));
    });

    instance.get('/api/v1/system/tools', async (request, reply) => {
      return sendSuccess(
        reply,
        { postgres: detectPostgresInstallations(), docker: detectDocker() },
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/projects/:id/postgres', async (request, reply) => {
      return sendSuccess(
        reply,
        options.projects.postgresInfo(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/projects/:id/backup', async (request, reply) => {
      return sendSuccess(
        reply,
        await options.projects.backupPostgres(projectIdOf(request)),
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/projects/:id', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      return sendSuccess(
        reply,
        { config, runtime: options.supervisor.getSnapshot(config.id) },
        requestIdOf(request),
      );
    });

    instance.put('/api/v1/projects/:id', async (request, reply) => {
      const updated = options.projects.updateProject(projectIdOf(request), request.body);
      return sendSuccess(reply, updated, requestIdOf(request));
    });

    instance.delete('/api/v1/projects/:id', async (request, reply) => {
      const force = queryOf(request).force === 'true' || queryOf(request).force === '1';
      const removed = options.projects.deleteProject(projectIdOf(request), { force });
      return sendSuccess(reply, removed, requestIdOf(request));
    });

    instance.post('/api/v1/projects/:id/start', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      await options.stacks.startProjectWithDependencies(config.id, 'USER');
      return sendSuccess(reply, options.supervisor.getSnapshot(config.id), requestIdOf(request));
    });

    instance.post('/api/v1/projects/:id/stop', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      await options.supervisor.stopProject(config.id, 'STOP_MANUAL');
      return sendSuccess(reply, options.supervisor.getSnapshot(config.id), requestIdOf(request));
    });

    instance.post('/api/v1/projects/:id/restart', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      await options.supervisor.restartProject(config.id);
      return sendSuccess(reply, options.supervisor.getSnapshot(config.id), requestIdOf(request));
    });

    instance.get('/api/v1/projects/:id/status', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      return sendSuccess(reply, options.supervisor.getSnapshot(config.id), requestIdOf(request));
    });

    instance.get('/api/v1/projects/:id/logs', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      const query = queryOf(request);
      const tail = parsePositiveInt(query.tail, 200, 1, 5_000);
      const instanceId =
        typeof query.instanceId === 'string' && query.instanceId.length > 0
          ? query.instanceId
          : undefined;
      return sendSuccess(
        reply,
        options.projects.tailLogs(config.id, tail, instanceId),
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/projects/:id/events', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      const limit = parsePositiveInt(queryOf(request).limit, 50, 1, 500);
      return sendSuccess(
        reply,
        options.projects.listEvents({ projectId: config.id, limit }),
        requestIdOf(request),
      );
    });

    instance.get('/api/v1/projects/:id/instances', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      const limit = parsePositiveInt(queryOf(request).limit, 20, 1, 100);
      const instances = options.repositories.instances
        .listByProject(config.id, limit)
        .map((row) => ({
          id: row.id,
          projectId: row.projectId,
          pid: row.pid,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          exitCode: row.exitCode,
          exitSignal: row.exitSignal,
          terminationReason: row.terminationReason,
          status: row.status,
          createdAt: row.createdAt,
        }));
      return sendSuccess(reply, instances, requestIdOf(request));
    });

    instance.get('/api/v1/events', async (request, reply) => {
      const query = queryOf(request);
      const limit = parsePositiveInt(query.limit, 50, 1, 500);
      const projectId = typeof query.projectId === 'string' ? query.projectId : undefined;
      return sendSuccess(
        reply,
        options.projects.listEvents(projectId === undefined ? { limit } : { limit, projectId }),
        requestIdOf(request),
      );
    });

    instance.post('/api/v1/bulk/start', async (request, reply) => {
      const body = parseBulkProjectsRequest(request.body);
      const result = await options.stacks.startProjects(body.projectIds);
      return sendSuccess(reply, result, requestIdOf(request));
    });

    instance.post('/api/v1/bulk/stop', async (request, reply) => {
      const body = parseBulkProjectsRequest(request.body);
      const result = await options.stacks.stopProjects(body.projectIds);
      return sendSuccess(reply, result, requestIdOf(request));
    });

    instance.get('/api/v1/settings', async (request, reply) => {
      return sendSuccess(reply, options.getSettings(), requestIdOf(request));
    });

    instance.get('/api/v1/system/metrics', async (request, reply) => {
      const snapshot = options.metrics.latest() ?? (await options.metrics.collectNow());
      return sendSuccess(reply, snapshot, requestIdOf(request));
    });

    instance.post('/api/v1/system/backup', async (request, reply) => {
      return sendSuccess(reply, options.backups.create(), requestIdOf(request), 201);
    });

    instance.get('/api/v1/system/backups', async (request, reply) => {
      return sendSuccess(reply, options.backups.list(), requestIdOf(request));
    });

    instance.post('/api/v1/system/restore', async (request, reply) => {
      const body = parseRestoreBackupRequest(request.body);
      return sendSuccess(reply, options.backups.requestRestore(body.file), requestIdOf(request));
    });

    instance.get('/api/v1/ports/:port', async (request, reply) => {
      const params = request.params as { port?: unknown };
      const port = Number(params.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new AppError('VALIDATION_ERROR', `porta inválida: ${String(params.port)}`);
      }
      return sendSuccess(reply, await checkPort(port), requestIdOf(request));
    });

    instance.get('/api/v1/ports', async (request, reply) => {
      const summaries = options.projects
        .listProjects()
        .filter((summary) => summary.config.port !== null);

      const results = await runWithConcurrency(summaries, 4, async (summary) => {
        const port = summary.config.port as number;
        const check = await checkPort(port);
        return {
          projectId: summary.config.id,
          name: summary.config.name,
          port: check.port,
          inUse: check.inUse,
          ownerPid: check.ownerPid,
        };
      });
      return sendSuccess(reply, results, requestIdOf(request));
    });

    instance.put('/api/v1/settings', async (request, reply) => {
      return sendSuccess(reply, options.updateSettings(request.body), requestIdOf(request));
    });
  };

  const start = async (): Promise<EngineApiInfo> => {
    if (info) {
      return info;
    }

    const instance = Fastify({
      logger: false,
      bodyLimit: MAX_BODY_BYTES,
      trustProxy: false,
    });
    app = instance;

    await instance.register(cors, {
      origin: (origin, callback) => {
        // Reflete apenas origens da allowlist (obrigatório com credentials).
        // Requisições sem Origin (CLI, testes, curl) não levam cabeçalho CORS.
        if (typeof origin !== 'string' || !isAllowedOrigin(origin, corsOrigins)) {
          callback(null, false);
          return;
        }
        callback(null, origin);
      },
      // A UI web usa cookie de sessão quando servida por outra origem da
      // allowlist (ex.: túnel), então o preflight precisa permitir credenciais
      // e o cabeçalho de CSRF.
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'authorization',
        'content-type',
        'x-request-id',
        'x-protocol-version',
        'x-csrf-token',
      ],
      maxAge: 600,
    });
    await instance.register(websocket, { options: { maxPayload: MAX_BODY_BYTES } });

    // Endpoints sem corpo (start/stop/restart) precisam aceitar POST vazio de
    // clientes que enviam content-type de formulário por padrão (PowerShell).
    instance.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        const text = typeof body === 'string' ? body.trim() : '';
        if (text !== '') {
          done(
            new AppError(
              'VALIDATION_ERROR',
              'Este endpoint não aceita corpo; use application/json apenas quando houver payload.',
            ),
            undefined,
          );
          return;
        }
        done(null, undefined);
      },
    );

    const webRoot = options.webDir === null ? null : resolve(options.webDir);
    instance.get('/*', async (request, reply) => {
      const rawPath = request.url.split('?')[0] ?? '/';
      if (rawPath.startsWith('/api/')) {
        return sendFailure(
          reply,
          {
            code: 'ROUTE_NOT_FOUND',
            message: `Rota não encontrada: ${request.method} ${rawPath}`,
          },
          requestIdOf(request),
          404,
        );
      }
      if (webRoot === null) {
        return reply.code(404).type('text/plain; charset=utf-8').send('Web UI não disponível.');
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        return reply.code(400).type('text/plain; charset=utf-8').send('Bad Request');
      }
      const relative = decoded.replace(/^\/+/, '');
      const candidate = relative === '' ? webRoot : resolve(webRoot, relative);
      if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) {
        return reply.code(403).type('text/plain; charset=utf-8').send('Forbidden');
      }

      let file = candidate;
      let stats = safeStatSync(file);
      if (stats?.isDirectory()) {
        file = join(file, 'index.html');
        stats = safeStatSync(file);
      }
      if (!stats?.isFile() && extname(relative) === '') {
        file = join(webRoot, 'index.html');
        stats = safeStatSync(file);
      }
      if (stats === null || !stats.isFile()) {
        return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
      }

      const ext = extname(file).toLowerCase();
      reply.header('content-type', WEB_MIME[ext] ?? 'application/octet-stream');
      reply.header(
        'cache-control',
        ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      );
      if (ext === '.html') {
        reply.header('content-security-policy', WEB_CSP);
      }
      return reply.send(createReadStream(file));
    });

    instance.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') {
        return;
      }
      if (request.url.startsWith('/api/v1/ws')) {
        return;
      }
      if (!isAllowedHostHeader(request.headers.host, boundPort, options.webHosts.list())) {
        return sendFailure(
          reply,
          { code: 'UNAUTHORIZED', message: 'Host não permitido' },
          requestIdOf(request),
          401,
        );
      }
      const protocol = request.headers['x-protocol-version'];
      if (typeof protocol === 'string' && protocol !== String(PROTOCOL_VERSION)) {
        return sendFailure(
          reply,
          {
            code: 'PROTOCOL_VERSION_MISMATCH',
            message: `Engine usa o protocolo ${PROTOCOL_VERSION}; cliente enviou ${protocol}`,
          },
          requestIdOf(request),
          409,
        );
      }

      // UI e assets são públicos; a API exige Bearer ou sessão web.
      if (!request.url.startsWith('/api/v1')) {
        return;
      }
      if (request.url.startsWith('/api/v1/auth/')) {
        return;
      }

      const bearer = extractBearerToken(request.headers.authorization);
      const bearerValid = bearer !== null && tokensMatch(options.token, bearer);
      const sessionId = options.webAuth.sessionIdFrom(request.headers.cookie);

      if (!bearerValid && sessionId === null) {
        return sendFailure(
          reply,
          { code: 'UNAUTHORIZED', message: 'Sessão ou token inválido' },
          requestIdOf(request),
          401,
        );
      }

      // Sessão de navegador exige CSRF em métodos que alteram estado.
      if (!bearerValid && sessionId !== null) {
        const method = request.method.toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          const header = request.headers['x-csrf-token'];
          const expected = options.webAuth.csrfOf(sessionId);
          if (typeof header !== 'string' || expected === null || !tokensMatch(expected, header)) {
            return sendFailure(
              reply,
              { code: 'UNAUTHORIZED', message: 'CSRF inválido' },
              requestIdOf(request),
              403,
            );
          }
        }
      }
    });

    instance.addHook('onSend', async (request, reply, payload) => {
      reply.header('x-content-type-options', 'nosniff');
      if (request.url.startsWith('/api/')) {
        reply.header('cache-control', 'no-store');
      }
      return payload;
    });

    instance.setErrorHandler((error, request, reply) => {
      const requestId = requestIdOf(request);
      if (isAppError(error)) {
        return sendFailure(reply, error.toJSON(), requestId, ERROR_HTTP_STATUS[error.code]);
      }
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        return sendFailure(
          reply,
          {
            code: 'VALIDATION_ERROR',
            message: error instanceof Error ? error.message : 'Requisição inválida',
          },
          requestId,
          statusCode,
        );
      }
      options.logger.error(
        'Erro não tratado na API',
        { requestId, method: request.method, url: request.url },
        error,
      );
      return sendFailure(
        reply,
        { code: 'INTERNAL_ERROR', message: 'Erro interno do Engine' },
        requestId,
        500,
      );
    });

    instance.setNotFoundHandler((request, reply) => {
      return sendFailure(
        reply,
        {
          code: 'ROUTE_NOT_FOUND',
          message: `Rota não encontrada: ${request.method} ${request.url}`,
        },
        requestIdOf(request),
        404,
      );
    });

    gateway = new WebSocketGateway({
      events: options.events,
      supervisor: options.supervisor,
      logger: options.logger,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    });
    gateway.start();
    const activeGateway = gateway;

    instance.get('/api/v1/ws', { websocket: true }, (socket, request) => {
      if (!isAllowedHostHeader(request.headers.host, boundPort, options.webHosts.list())) {
        socket.close(1008, 'forbidden');
        return;
      }
      const token =
        extractQueryToken((request.query as Record<string, unknown> | undefined)?.token) ??
        extractBearerToken(request.headers.authorization);
      const bearerValid = token !== null && tokensMatch(options.token, token);
      const sessionId = options.webAuth.sessionIdFrom(request.headers.cookie);
      if (!bearerValid && sessionId === null) {
        socket.close(1008, 'unauthorized');
        return;
      }
      activeGateway.attach(socket as unknown as WebSocketLike);
    });

    registerRoutes(instance);

    await listenWithFallback(instance, options.preferredPort ?? 0);
    const address = instance.server.address();
    if (!address || typeof address === 'string') {
      await instance.close();
      throw new AppError('INTERNAL_ERROR', 'Não foi possível obter a porta da API local');
    }

    boundPort = address.port;
    info = {
      host: '127.0.0.1',
      port: boundPort,
      baseUrl: `http://127.0.0.1:${boundPort}`,
      token: options.token,
      websocketPath: '/api/v1/ws',
    };
    options.logger.info('API local pronta', { baseUrl: info.baseUrl });
    return info;
  };

  const stop = async (): Promise<void> => {
    gateway?.closeAll();
    gateway = null;
    const instance = app;
    app = null;
    info = null;
    boundPort = 0;
    if (instance) {
      await instance.close();
    }
  };

  return {
    start,
    stop,
    get info() {
      return info;
    },
  };
}
