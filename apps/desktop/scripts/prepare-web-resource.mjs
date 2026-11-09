import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copia a UI compilada para os recursos do Engine, que a serve em modo web
 * (headless) no mesmo endereço da API local.
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptDir);
const dist = join(desktopDir, 'dist');
const target = join(desktopDir, 'src-tauri', 'resources', 'engine', 'web');

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`UI não encontrada em ${dist}. Rode "pnpm build" antes.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, {
  recursive: true,
  // Sourcemaps não são necessários para servir a UI e dobrariam o instalador.
  filter: (source) => !source.endsWith('.map'),
});

// Remove assets antigos que o Tauri manteve na área de staging.
for (const profile of ['release', 'debug']) {
  rmSync(join(desktopDir, 'src-tauri', 'target', profile, 'resources', 'engine', 'web'), {
    recursive: true,
    force: true,
  });
}
console.log(`UI web copiada para ${target}`);
