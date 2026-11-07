import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * Ponte de desenvolvimento: o navegador não lê o filesystem, então o Vite
 * publica o conteúdo de engine.json em /__engine. Em produção (Tauri), o
 * shell injeta `window.__LSM_ENGINE__` via comando nativo.
 */
function engineInfoBridge(): Plugin {
  return {
    name: 'lsm-engine-info-bridge',
    configureServer(server) {
      server.middlewares.use('/__engine', (_request, response) => {
        const dataDir =
          process.env.LSM_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'LocalServerManager');
        const infoPath = join(dataDir, 'engine', 'engine.json');
        try {
          const info = JSON.parse(readFileSync(infoPath, 'utf8')) as {
            api?: unknown;
          };
          if (!info.api) {
            throw new Error('engine.json sem bloco "api"');
          }
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.setHeader('cache-control', 'no-store');
          response.end(JSON.stringify(info.api));
        } catch (error) {
          response.statusCode = 503;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              error: 'ENGINE_OFFLINE',
              message: `Não foi possível ler ${infoPath}`,
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), engineInfoBridge()],
  server: {
    port: 1420,
    strictPort: true,
  },
  preview: {
    port: 1421,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
  },
});
