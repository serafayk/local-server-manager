import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ScanPortSource, ScannedProject, ScanRootResponse } from '@lsm/contracts';
import { AppError } from '@lsm/shared';
import { detectPackageManager, type DetectedPackageManager } from './package-manager';

const MAX_PROJECTS = 100;
const SRC_SCAN_DEPTH = 3;
/** `start`/`dev` são os scripts que realmente sobem um servidor. */
const RUNNABLE_SCRIPTS = ['start', 'dev', 'serve', 'preview'] as const;
const WATCHER_HINT = /\b(tsx|nodemon|webpack|vite|next)\b.*\bwatch\b|\bwatch\b|--watch/i;

interface PackageJson {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  workspaces?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Expande apenas padrões de um nível (`apps/*`); ignora `**` para não varrer a árvore toda. */
function expandPattern(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized.includes('**')) {
    return [];
  }
  if (!normalized.endsWith('/*')) {
    const absolute = resolve(root, normalized);
    return isDirectory(absolute) ? [absolute] : [];
  }

  const parent = resolve(root, normalized.slice(0, -2));
  if (!isDirectory(parent)) {
    return [];
  }
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

function workspacePatterns(root: string, rootPackage: PackageJson | null): string[] {
  const patterns: string[] = [];
  const workspaceYaml = readIfExists(join(root, 'pnpm-workspace.yaml'));

  if (workspaceYaml !== null) {
    let inPackages = false;
    for (const rawLine of workspaceYaml.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trimEnd();
      if (/^packages\s*:/i.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line) && line.trim() !== '') {
        inPackages = false;
      }
      const item = /^\s*-\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
      if (inPackages && item?.[1]) {
        patterns.push(item[1].trim());
      }
    }
  }

  const workspaces = rootPackage?.workspaces;
  if (Array.isArray(workspaces)) {
    for (const item of workspaces) {
      if (typeof item === 'string') {
        patterns.push(item);
      }
    }
  } else if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    for (const item of workspaces.packages) {
      if (typeof item === 'string') {
        patterns.push(item);
      }
    }
  }

  return [...new Set(patterns)];
}

function scriptEntries(packageJson: PackageJson): Record<string, string> {
  const scripts: Record<string, string> = {};
  if (isRecord(packageJson.scripts)) {
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (typeof command === 'string') {
        scripts[name] = command;
      }
    }
  }
  return scripts;
}

function hasNextDependency(packageJson: PackageJson): boolean {
  for (const field of [packageJson.dependencies, packageJson.devDependencies]) {
    if (isRecord(field) && typeof field.next === 'string') {
      return true;
    }
  }
  return false;
}

/** Apps Expo/React Native não são servidores locais no sentido do gerenciador. */
function isMobileApp(packageJson: PackageJson): boolean {
  for (const field of [packageJson.dependencies, packageJson.devDependencies]) {
    if (
      isRecord(field) &&
      (typeof field.expo === 'string' || typeof field['react-native'] === 'string')
    ) {
      return true;
    }
  }
  return false;
}

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  const content = readIfExists(path);
  if (content === null) {
    return values;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function numericPort(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value.replace(/_/g, ''), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

/** Procura `XXX_PORT: z...default(3001)` nos arquivos de configuração do app. */
function findConfigPort(directory: string): { key: string; port: number } | null {
  const candidates: string[] = [];
  const src = join(directory, 'src');
  for (const base of [directory, src]) {
    if (!isDirectory(base)) {
      continue;
    }
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isFile() && /config\.(?:ts|js|mjs|cjs)$/i.test(entry.name)) {
          candidates.push(join(base, entry.name));
        }
      }
    } catch {
      // pasta ilegível: ignora
    }
  }

  for (const file of candidates) {
    const content = readIfExists(file);
    if (content === null) {
      continue;
    }
    const match =
      /([A-Z][A-Z0-9_]*PORT)\s*:\s*[\s\S]{0,240}?\.default\(\s*([0-9][0-9_]*)\s*\)/.exec(content);
    if (match?.[1] && match[2]) {
      const port = numericPort(match[2]);
      if (port !== null) {
        return { key: match[1], port };
      }
    }
  }
  return null;
}

function collectSourceText(directory: string, depth = SRC_SCAN_DEPTH): string {
  if (depth < 0) {
    return '';
  }
  let text = '';
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          text += collectSourceText(path, depth - 1);
        }
      } else if (/\.(?:ts|js|mjs|cjs)$/i.test(entry.name)) {
        text += readIfExists(path) ?? '';
      }
      if (text.length > 400_000) {
        break;
      }
    }
  } catch {
    // pasta ilegível: ignora
  }
  return text;
}

function titleCase(value: string): string {
  const ACRONYMS: Record<string, string> = {
    ai: 'AI',
    api: 'API',
    whatsapp: 'WhatsApp',
    web: 'Web',
    ui: 'UI',
    db: 'DB',
    http: 'HTTP',
    ws: 'WS',
  };
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      return ACRONYMS[lower] ?? part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function shortPackageName(packageName: string | null): string | null {
  if (packageName === null || packageName.trim() === '') {
    return null;
  }
  const parts = packageName.replace(/^@[^/]+\//, '').split('/');
  return parts[parts.length - 1] ?? null;
}

function chooseScript(
  scripts: Record<string, string>,
  hasNext: boolean,
): { script: string | null; notes: string[] } {
  const notes: string[] = [];
  const available = Object.keys(scripts);

  if (hasNext) {
    if (available.includes('dev')) {
      if (available.includes('start')) {
        notes.push('Next.js: "start" exige "next build" antes; usando "dev".');
      }
      return { script: 'dev', notes };
    }
    if (available.includes('start')) {
      notes.push('Next.js sem build de produção: rode "next build" ou use "dev".');
      return { script: 'start', notes };
    }
  }

  for (const candidate of RUNNABLE_SCRIPTS) {
    if (available.includes(candidate)) {
      const command = scripts[candidate] ?? '';
      if (WATCHER_HINT.test(command)) {
        notes.push(
          `O script "${candidate}" usa watcher; um crash do app filho pode não chegar ao supervisor.`,
        );
      }
      return { script: candidate, notes };
    }
  }

  return { script: null, notes };
}

function detectPort(
  directory: string,
  env: Record<string, string>,
  scripts: Record<string, string>,
  preferredScript: string | null,
): { port: number | null; portSource: ScanPortSource } {
  const configPort = findConfigPort(directory);
  if (configPort) {
    const fromEnv = numericPort(env[configPort.key]);
    if (fromEnv !== null) {
      return { port: fromEnv, portSource: 'env' };
    }
  }

  const fromScript = portFromScripts(scripts, preferredScript);
  if (fromScript !== null) {
    return { port: fromScript, portSource: 'script' };
  }

  if (configPort) {
    return { port: configPort.port, portSource: 'config' };
  }

  const snake = basename(directory)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  for (const key of [`${snake}_PORT`, 'PORT']) {
    const value = numericPort(env[key]);
    if (value !== null) {
      return { port: value, portSource: 'env' };
    }
  }

  return { port: null, portSource: 'none' };
}

/** Extrai `-p 3000` / `--port=3000` do script escolhido (ou de qualquer um). */
function portFromScripts(scripts: Record<string, string>, preferred: string | null): number | null {
  const order = preferred
    ? [preferred, ...Object.keys(scripts).filter((name) => name !== preferred)]
    : Object.keys(scripts);
  for (const name of order) {
    const command = scripts[name];
    if (command === undefined) {
      continue;
    }
    const match = /(?:^|\s)(?:-p|--port)(?:=|\s+)(\d{2,5})\b/.exec(command);
    if (match?.[1]) {
      const port = numericPort(match[1]);
      if (port !== null) {
        return port;
      }
    }
  }
  return null;
}

function detectHealth(
  directory: string,
  port: number | null,
  hasNext: boolean,
): { healthType: 'http' | 'tcp'; healthTarget: string | null } {
  if (port === null) {
    // Sem porta não há alvo; mantém o tipo previsível para o formulário.
    return { healthType: hasNext ? 'tcp' : 'http', healthTarget: null };
  }
  const url = `http://127.0.0.1:${port}`;
  if (hasNext) {
    // Next compila sob demanda; TCP evita timeout falso no primeiro acesso.
    return { healthType: 'tcp', healthTarget: `127.0.0.1:${port}` };
  }
  const sourceDirectory = join(directory, 'src');
  const source = isDirectory(sourceDirectory) ? collectSourceText(sourceDirectory) : '';
  if (/['"]\/health['"]/.test(source)) {
    return { healthType: 'http', healthTarget: `${url}/health` };
  }
  return { healthType: 'tcp', healthTarget: `127.0.0.1:${port}` };
}

function toCandidate(options: {
  root: string;
  repoName: string;
  directory: string;
  packageJson: PackageJson;
  env: Record<string, string>;
  startupOrder: number;
  rootPackageManager: DetectedPackageManager;
}): ScannedProject {
  const { root, repoName, directory, packageJson, env, startupOrder, rootPackageManager } = options;
  const packageName = typeof packageJson.name === 'string' ? packageJson.name : null;
  const scripts = scriptEntries(packageJson);
  const hasNext = hasNextDependency(packageJson);
  const mobile = isMobileApp(packageJson);
  const { script, notes } = chooseScript(scripts, hasNext);
  const { port, portSource } = detectPort(directory, env, scripts, script);
  const health = detectHealth(directory, port, hasNext);

  if (mobile) {
    notes.push('App Expo/React Native: normalmente não é gerenciado como servidor local.');
  }

  const friendly = titleCase(shortPackageName(packageName) ?? basename(directory));
  const relativeDirectory = (relative(root, directory) || '.').split(sep).join('/');
  const isRoot = relativeDirectory === '.';

  if (!isRoot && packageName === null) {
    notes.push('package.json sem "name".');
  }

  const ownPackageManager = detectPackageManager(directory);
  const packageManager = ownPackageManager.confirmed
    ? ownPackageManager
    : rootPackageManager.confirmed
      ? rootPackageManager
      : ownPackageManager;

  return {
    name: isRoot ? friendly : `${repoName} · ${friendly}`,
    packageName,
    directory,
    relativeDirectory,
    packageManager: packageManager.packageManager,
    script,
    availableScripts: Object.keys(scripts).sort((a, b) => a.localeCompare(b)),
    runnable: script !== null,
    recommended: script !== null && !mobile,
    port,
    portSource,
    healthType: health.healthType,
    healthTarget: health.healthTarget,
    startupOrder,
    notes,
  };
}

/**
 * Varredura read-only da raiz de um repositório para propor projetos.
 * Reconhece monorepos pnpm/npm/yarn/turbo, lê portas de `.env` e dos arquivos
 * de configuração e identifica o endpoint de health. Nunca executa nada.
 */
export function scanProjectRoot(requestedRoot: string): ScanRootResponse {
  const root = resolve(requestedRoot.trim());
  if (!isAbsolute(root) || !isDirectory(root)) {
    throw new AppError(
      'WORKING_DIRECTORY_NOT_FOUND',
      `Diretório não encontrado: ${requestedRoot}`,
      {
        directory: requestedRoot,
      },
    );
  }

  const rootPackage = readJson(join(root, 'package.json'));
  const patterns = workspacePatterns(root, rootPackage);
  const isMonorepo =
    patterns.length > 0 ||
    existsSync(join(root, 'turbo.json')) ||
    existsSync(join(root, 'lerna.json'));

  // Sem workspaces declarados, o turbo ainda costuma organizar apps/.
  const effectivePatterns =
    patterns.length > 0 ? patterns : isMonorepo ? ['apps/*', 'packages/*'] : [];

  const repoName = basename(root);
  const rootEnv = parseEnvFile(join(root, '.env'));
  const rootPackageManager = detectPackageManager(root);
  const directories: string[] = [];
  const seen = new Set<string>();

  for (const pattern of effectivePatterns) {
    for (const directory of expandPattern(root, pattern)) {
      const key = directory.toLowerCase();
      if (!seen.has(key) && existsSync(join(directory, 'package.json'))) {
        seen.add(key);
        directories.push(directory);
      }
      if (directories.length >= MAX_PROJECTS) {
        break;
      }
    }
  }

  if (directories.length === 0) {
    if (rootPackage === null) {
      throw new AppError('PROJECT_INVALID_CONFIG', `Nenhum package.json encontrado em ${root}`, {
        directory: root,
      });
    }
    directories.push(root);
  }

  const projects = directories.map((directory, index) => {
    const appEnv = { ...rootEnv, ...parseEnvFile(join(directory, '.env')) };
    const packageJson = readJson(join(directory, 'package.json')) ?? {};
    return toCandidate({
      root,
      repoName,
      directory,
      packageJson,
      env: appEnv,
      startupOrder: index + 1,
      rootPackageManager,
    });
  });

  return {
    root,
    isMonorepo,
    groupSuggestion: repoName,
    projects,
  };
}
