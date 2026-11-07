import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectSummary, RuntimeSnapshot } from '@lsm/contracts';
import {
  resolvePackageManagerInvocation,
  type PackageManager,
  PACKAGE_MANAGERS,
} from '@lsm/platform-win';
import { AppError, isAppError } from '@lsm/shared';
import type { Engine } from '../bootstrap/engine';
import { getFlag, getFlags, hasFlag, parseLine, type ParsedLine } from './tokenizer';

export type CommandOutcome = 'continue' | 'exit';

export interface CommandContext {
  engine: Engine;
}

export async function executeLine(context: CommandContext, line: string): Promise<CommandOutcome> {
  let parsed: ParsedLine | null;
  try {
    parsed = parseLine(line);
  } catch (error) {
    printError(error);
    return 'continue';
  }
  if (!parsed) {
    return 'continue';
  }

  try {
    switch (parsed.command.toLowerCase()) {
      case 'help':
      case '?':
        printHelp();
        return 'continue';
      case 'exit':
      case 'quit':
        return 'exit';
      case 'info':
        console.log(JSON.stringify(context.engine.info(), null, 2));
        return 'continue';
      case 'doctor':
        runDoctor(context);
        return 'continue';
      case 'projects':
        await handleProjects(context, parsed);
        return 'continue';
      case 'start': {
        const target = requireTarget(parsed);
        await context.engine.supervisor.startProject(target, 'USER');
        console.log(`start enviado: ${target}`);
        return 'continue';
      }
      case 'stop': {
        const target = requireTarget(parsed);
        await context.engine.supervisor.stopProject(target, 'STOP_MANUAL');
        console.log(`stop enviado: ${target}`);
        return 'continue';
      }
      case 'restart': {
        const target = requireTarget(parsed);
        await context.engine.supervisor.restartProject(target);
        console.log(`restart enviado: ${target}`);
        return 'continue';
      }
      case 'status':
        printStatus(context, parsed.args[0]);
        return 'continue';
      case 'logs':
        printLogs(context, parsed);
        return 'continue';
      case 'events':
        printEvents(context, parsed);
        return 'continue';
      default:
        throw new AppError(
          'VALIDATION_ERROR',
          `Comando desconhecido: "${parsed.command}". Use "help".`,
        );
    }
  } catch (error) {
    printError(error);
    return 'continue';
  }
}

function requireTarget(parsed: ParsedLine): string {
  const target = parsed.args[0];
  if (!target) {
    throw new AppError('VALIDATION_ERROR', `uso: ${parsed.command} <id|nome>`);
  }
  return target;
}

async function handleProjects(context: CommandContext, parsed: ParsedLine): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case 'list':
      printProjectList(context.engine.projects.listProjects());
      return;
    case 'add':
      addProject(context, parsed);
      return;
    case 'remove': {
      const target = parsed.args[1];
      if (!target) {
        throw new AppError('VALIDATION_ERROR', 'uso: projects remove <id|nome>');
      }
      const removed = context.engine.projects.deleteProject(target);
      console.log(`Projeto removido: ${removed.name} (${removed.id})`);
      return;
    }
    default:
      throw new AppError('VALIDATION_ERROR', 'uso: projects <list|add|remove>');
  }
}

function addProject(context: CommandContext, parsed: ParsedLine): void {
  const flags = parsed.flags;
  const name = getFlag(flags, 'name');
  const directory = getFlag(flags, 'dir');
  if (!name || !directory) {
    throw new AppError(
      'VALIDATION_ERROR',
      'uso: projects add --name "Fiscal API" --dir "C:\\dev\\fiscal" ' +
        '(--exec node --arg server.js | --pm pnpm --script dev) [--port 3000] [--env K=V] [--boot]',
    );
  }

  const environment: Record<string, string> = {};
  for (const entry of getFlags(flags, 'env')) {
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex <= 0) {
      throw new AppError('VALIDATION_ERROR', `--env inválido: "${entry}". Use K=V.`);
    }
    environment[entry.slice(0, equalsIndex)] = entry.slice(equalsIndex + 1);
  }

  let executable = getFlag(flags, 'exec');
  let args = getFlags(flags, 'arg');
  const packageManager = getFlag(flags, 'pm');

  if (packageManager !== undefined) {
    if (executable !== undefined) {
      throw new AppError('VALIDATION_ERROR', 'use --exec ou --pm, não ambos.');
    }
    if (!PACKAGE_MANAGERS.includes(packageManager as PackageManager)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `package manager inválido: "${packageManager}". Use ${PACKAGE_MANAGERS.join(', ')}.`,
      );
    }
    const script = getFlag(flags, 'script');
    if (!script) {
      throw new AppError('VALIDATION_ERROR', '--pm exige --script <nome-do-script>.');
    }
    const invocation = resolvePackageManagerInvocation(packageManager as PackageManager, script, {
      cwd: directory,
    });
    executable = invocation.executable;
    args = invocation.args;
    for (const warning of invocation.warnings) {
      console.log(`AVISO: ${warning}`);
    }
  }

  if (!executable) {
    throw new AppError(
      'VALIDATION_ERROR',
      'informe --exec <executável> (com --arg) ou --pm <npm|pnpm|yarn|bun> --script <nome>.',
    );
  }

  const portRaw = getFlag(flags, 'port');
  const port = portRaw === undefined ? null : Number.parseInt(portRaw, 10);
  if (portRaw !== undefined && (!Number.isInteger(port) || port === null || port < 1)) {
    throw new AppError('VALIDATION_ERROR', `porta inválida: "${portRaw}".`);
  }

  const startupOrderRaw = getFlag(flags, 'order');
  const startupOrder = startupOrderRaw === undefined ? 0 : Number.parseInt(startupOrderRaw, 10);
  if (!Number.isInteger(startupOrder) || startupOrder < 0) {
    throw new AppError('VALIDATION_ERROR', `--order inválido: "${startupOrderRaw}".`);
  }

  const project = context.engine.projects.createProject({
    name,
    description: getFlag(flags, 'desc') ?? null,
    workingDirectory: directory,
    runtime: { executable, args },
    environment,
    port,
    portSource: port !== null ? 'fixed' : 'none',
    startOnBoot: hasFlag(flags, 'boot'),
    startupOrder,
  });

  console.log(`Projeto criado: ${project.name} (${project.id})`);
  console.log(`Comando: ${[project.runtime.executable, ...project.runtime.args].join(' ')}`);
  console.log(`Diretório: ${project.workingDirectory}`);
  if (project.port !== null) {
    console.log(`Porta: ${project.port}`);
  }
}

function printProjectList(summaries: ProjectSummary[]): void {
  if (summaries.length === 0) {
    console.log('Nenhum projeto cadastrado. Use "projects add".');
    return;
  }
  const rows = summaries.map((summary) => projectRow(summary));
  printTable(['NOME', 'STATUS', 'SAÚDE', 'PID', 'UP', 'PORTA', 'ID'], rows);
}

function projectRow(summary: ProjectSummary): string[] {
  const runtime = summary.runtime;
  return [
    summary.config.name,
    runtime.status,
    runtime.health,
    runtime.pid === null ? '-' : String(runtime.pid),
    formatUptime(runtime.startedAt),
    summary.config.port === null ? '-' : String(summary.config.port),
    summary.config.id.slice(0, 8),
  ];
}

function printStatus(context: CommandContext, target?: string): void {
  if (target) {
    const snapshot = context.engine.supervisor.getSnapshot(target);
    printRuntime(snapshot);
    return;
  }
  printProjectList(context.engine.projects.listProjects());
}

function printRuntime(snapshot: RuntimeSnapshot): void {
  console.log(
    [
      `projeto:       ${snapshot.projectId}`,
      `status:        ${snapshot.status}`,
      `desiredState:  ${snapshot.desiredState}`,
      `health:        ${snapshot.health}`,
      `pid:           ${snapshot.pid ?? '-'}`,
      `instanceId:    ${snapshot.instanceId ?? '-'}`,
      `iniciado em:   ${snapshot.startedAt ?? '-'}`,
      `uptime:        ${formatUptime(snapshot.startedAt)}`,
      `tentativas:    ${snapshot.restartAttempt}`,
      `última saída:  ${
        snapshot.lastExit
          ? `${snapshot.lastExit.reason} (code=${snapshot.lastExit.code ?? 'null'})`
          : '-'
      }`,
    ].join('\n'),
  );
}

function printLogs(context: CommandContext, parsed: ParsedLine): void {
  const target = requireTarget(parsed);
  const tailRaw = getFlag(parsed.flags, 'tail') ?? getFlag(parsed.flags, 'limit') ?? '50';
  const limit = Number.parseInt(tailRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new AppError('VALIDATION_ERROR', `--tail inválido: "${tailRaw}".`);
  }

  const result = context.engine.projects.tailLogs(target, limit);
  if (result.instanceId === null) {
    console.log('Nenhuma instância registrada para este projeto.');
    return;
  }
  if (result.records.length === 0) {
    console.log(`Nenhuma linha de log (instância ${result.instanceId}).`);
    return;
  }
  for (const record of result.records) {
    console.log(
      `${record.timestamp} ${record.stream.padEnd(6)} ${record.text}${record.truncated ? ' [TRUNCADO]' : ''}`,
    );
  }
}

function printEvents(context: CommandContext, parsed: ParsedLine): void {
  const projectFlag = getFlag(parsed.flags, 'project');
  const limitRaw = getFlag(parsed.flags, 'limit') ?? '20';
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError('VALIDATION_ERROR', `--limit inválido: "${limitRaw}".`);
  }
  const projectId = projectFlag ? context.engine.projects.getProject(projectFlag).id : undefined;
  const events = context.engine.projects.listEvents(
    projectId === undefined ? { limit } : { limit, projectId },
  );
  if (events.length === 0) {
    console.log('Nenhum evento registrado.');
    return;
  }
  for (const event of events) {
    const project = event.projectId ? event.projectId.slice(0, 8) : 'engine  ';
    console.log(
      `${event.createdAt} ${event.level.padEnd(5)} ${project} ${event.eventType} — ${event.message}`,
    );
  }
}

function runDoctor(context: CommandContext): void {
  const { engine } = context;
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({ name: 'Node >= 24', ok: major >= 24, detail: process.version });
  checks.push({ name: 'Plataforma', ok: true, detail: process.platform });
  checks.push({
    name: 'Diretório de dados',
    ok: existsSync(engine.paths.root),
    detail: engine.paths.root,
  });

  let writable = false;
  const probe = join(engine.paths.engineDir, '.doctor-probe');
  try {
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  checks.push({ name: 'Escrita em dados', ok: writable, detail: engine.paths.engineDir });

  let sqliteOk = false;
  try {
    engine.db.connection.prepare('SELECT 1').get();
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  checks.push({ name: 'SQLite acessível', ok: sqliteOk, detail: engine.paths.databaseFile });
  checks.push({
    name: 'Projetos cadastrados',
    ok: true,
    detail: String(engine.supervisor.listProjects().length),
  });
  checks.push({ name: 'Executável Node', ok: true, detail: process.execPath });

  for (const check of checks) {
    console.log(`${check.ok ? '[OK]   ' : '[FALHA]'} ${check.name}: ${check.detail}`);
  }
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const format = (row: string[]): string =>
    row.map((value, column) => (value ?? '').padEnd(widths[column] ?? 0)).join('  ');
  console.log(format(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(format(row));
  }
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) {
    return '-';
  }
  const elapsed = Date.now() - Date.parse(startedAt);
  if (Number.isNaN(elapsed) || elapsed < 0) {
    return '-';
  }
  const totalSeconds = Math.floor(elapsed / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function printError(error: unknown): void {
  if (isAppError(error)) {
    console.log(`ERRO [${error.code}] ${error.message}`);
    if (Array.isArray(error.details)) {
      for (const issue of error.details as Array<{ path?: string; message?: string }>) {
        console.log(`  - ${issue.path ?? '?'}: ${issue.message ?? 'inválido'}`);
      }
    }
    return;
  }
  console.log(`ERRO ${error instanceof Error ? error.message : String(error)}`);
}

function printHelp(): void {
  console.log(
    [
      'Comandos:',
      '  projects list',
      '  projects add --name "X" --dir "C:\\proj" [--exec node --arg server.js]',
      '               [--pm npm|pnpm|yarn|bun --script dev] [--port 3000]',
      '               [--env K=V] [--desc "..."] [--boot] [--order 0]',
      '  projects remove <id|nome>',
      '  start <id|nome> | stop <id|nome> | restart <id|nome>',
      '  status [id|nome]',
      '  logs <id|nome> [--tail 50]',
      '  events [--project <id|nome>] [--limit 20]',
      '  info | doctor | help | exit',
      '',
      'Dica: caminhos com espaço precisam de aspas. Use Ctrl+C ou "exit" para encerrar',
      '(o Engine para os projetos ao encerrar — ADR-008).',
    ].join('\n'),
  );
}

export { printError, printProjectList, projectRow, formatUptime };
