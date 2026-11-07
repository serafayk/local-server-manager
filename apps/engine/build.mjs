import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [
    path.join(packageDir, 'src/bootstrap/main.ts'),
    path.join(packageDir, 'src/dev-cli/main.ts'),
  ],
  outdir: path.join(packageDir, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
  external: ['node:*'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
