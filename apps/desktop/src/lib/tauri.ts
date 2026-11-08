export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

/** Import dinâmico para o bundle do navegador não carregar a API nativa. */
export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * Seletor de pasta nativo. No modo navegador retorna null e a interface
 * mantém o campo de texto como alternativa.
 */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const selected = await invokeTauri<string | null>('pick_folder', { title });
    return selected && selected.trim() !== '' ? selected : null;
  } catch {
    return null;
  }
}
