import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copia o Engine compilado e o node.exe para os recursos do Tauri.
 * Os binários não são versionados (.gitignore).
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptDir);
const repoRoot = join(desktopDir, '..', '..');

const bundle = join(repoRoot, 'apps', 'engine', 'dist', 'bootstrap', 'main.mjs');
if (!existsSync(bundle)) {
  console.error(
    `Bundle do Engine não encontrado em ${bundle}. Rode "pnpm --filter @lsm/engine build".`,
  );
  process.exit(1);
}

const resourcesDir = join(desktopDir, 'src-tauri', 'resources', 'engine');
mkdirSync(resourcesDir, { recursive: true });

copyFileSync(bundle, join(resourcesDir, 'engine.mjs'));
copyFileSync(process.execPath, join(resourcesDir, 'node.exe'));

console.log(`Recursos do Engine preparados em ${resourcesDir}`);
console.log(`node: ${process.execPath}`);
