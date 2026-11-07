import type { EngineEndpoint } from './api';

declare global {
  interface Window {
    /**
     * Injetado pelo shell Tauri na Fase 4b (comando nativo que lê
     * engine/engine.json). Em desenvolvimento, o Vite preenche via /__engine.
     */
    __LSM_ENGINE__?: EngineEndpoint;
  }
}

export async function resolveEngineEndpoint(): Promise<EngineEndpoint> {
  if (window.__LSM_ENGINE__) {
    return window.__LSM_ENGINE__;
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
