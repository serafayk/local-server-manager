import type { EngineEndpoint } from './api';

declare global {
  interface Window {
    /**
     * Injetado opcionalmente pelo shell (fallback). O caminho principal no
     * Tauri é o comando `ensure_engine`.
     */
    __LSM_ENGINE__?: EngineEndpoint;
    __TAURI_INTERNALS__?: unknown;
  }
}

async function resolveFromTauri(): Promise<EngineEndpoint | null> {
  if (!window.__TAURI_INTERNALS__) {
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<EngineEndpoint>('ensure_engine');
  } catch (error) {
    throw new Error(
      `Falha ao iniciar o Engine pelo shell: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function resolveEngineEndpoint(): Promise<EngineEndpoint> {
  const tauriEndpoint = await resolveFromTauri();
  if (tauriEndpoint) {
    return tauriEndpoint;
  }

  if (window.__LSM_ENGINE__) {
    return window.__LSM_ENGINE__;
  }

  // Web UI servida pelo próprio Engine: mesma origem e sessão por cookie.
  try {
    const status = await fetch('/api/v1/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (status.ok && (status.headers.get('content-type') ?? '').includes('application/json')) {
      return { baseUrl: window.location.origin, token: '', websocketPath: '/api/v1/ws' };
    }
  } catch {
    // Sem Engine na mesma origem; tenta a descoberta de desenvolvimento.
  }

  let response: Response;
  try {
    response = await fetch('/__engine', { cache: 'no-store' });
  } catch (error) {
    throw new Error(
      'Não foi possível consultar o Engine. Inicie o Engine (pnpm engine) e tente novamente.',
      { cause: error },
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      detail = '';
    }
    throw new Error(
      detail ||
        'Engine não encontrado. Inicie o Engine (pnpm engine) e clique em "Tentar novamente".',
    );
  }

  const data = (await response.json()) as Partial<EngineEndpoint>;
  if (!data.baseUrl || !data.token || !data.websocketPath) {
    throw new Error('Resposta de descoberta do Engine inválida (engine.json incompleto).');
  }
  return { baseUrl: data.baseUrl, token: data.token, websocketPath: data.websocketPath };
}
