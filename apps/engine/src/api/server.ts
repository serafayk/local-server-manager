import { basename } from 'node:path';
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
import { inspectProjectDirectory, resolvePackageManagerInvocation } from '@lsm/platform-win';
import { AppError, isAppError } from '@lsm/shared';
import type { Clock, Logger } from '@lsm/shared';
import {
  parseBulkProjectsRequest,
  parseDetectProjectRequest,
  parseImportProjectRequest,
} from '@lsm/validation';
import type { EventBus } from '../core/event-bus';
import type { LogManager } from '../log-manager/log-manager';
import type { ProjectService } from '../supervisor/project-service';
import type { Supervisor } from '../supervisor/supervisor';
import { extractBearerToken, extractQueryToken, tokensMatch } from './auth';
import {
  isAllowedHostHeader,
  isAllowedOrigin,
  parsePositiveInt,
  requestIdOf,
  sendFailure,
  sendSuccess,
} from './http';
import { WebSocketGateway, type WebSocketLike } from './websocket-gateway';

const MAX_BODY_BYTES = 1_048_576;

export interface ApiServerOptions {
  token: string;
  supervisor: Supervisor;
  projects: ProjectService;
  repositories: Repositories;
  logManager: LogManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
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
      const removed = options.projects.deleteProject(projectIdOf(request));
      return sendSuccess(reply, removed, requestIdOf(request));
    });

    instance.post('/api/v1/projects/:id/start', async (request, reply) => {
      const config = options.projects.getProject(projectIdOf(request));
      await options.supervisor.startProject(config.id, 'USER');
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
      const results = await options.supervisor.startProjects(body.projectIds);
      return sendSuccess(reply, { results }, requestIdOf(request));
    });

    instance.post('/api/v1/bulk/stop', async (request, reply) => {
      const body = parseBulkProjectsRequest(request.body);
      const results = await options.supervisor.stopProjects(body.projectIds);
      return sendSuccess(reply, { results }, requestIdOf(request));
    });

    instance.get('/api/v1/settings', async (request, reply) => {
      return sendSuccess(reply, options.getSettings(), requestIdOf(request));
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
        callback(null, isAllowedOrigin(origin, corsOrigins));
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-request-id', 'x-protocol-version'],
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

    instance.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') {
        return;
      }
      if (request.url.startsWith('/api/v1/ws')) {
        return;
      }
      if (!isAllowedHostHeader(request.headers.host, boundPort)) {
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
      const token = extractBearerToken(request.headers.authorization);
      if (!token || !tokensMatch(options.token, token)) {
        return sendFailure(
          reply,
          { code: 'UNAUTHORIZED', message: 'Token inválido ou ausente' },
          requestIdOf(request),
          401,
        );
      }
    });

    instance.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
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
      if (!isAllowedHostHeader(request.headers.host, boundPort)) {
        socket.close(1008, 'forbidden');
        return;
      }
      const token =
        extractQueryToken((request.query as Record<string, unknown> | undefined)?.token) ??
        extractBearerToken(request.headers.authorization);
      if (!token || !tokensMatch(options.token, token)) {
        socket.close(1008, 'unauthorized');
        return;
      }
      activeGateway.attach(socket as unknown as WebSocketLike);
    });

    registerRoutes(instance);

    await instance.listen({ host: '127.0.0.1', port: 0 });
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
