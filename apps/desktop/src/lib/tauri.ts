export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

/** Abre uma URL no navegador padrão (fora do webview do app). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('URL inválida');
  }
  if (isTauriRuntime()) {
    await invokeTauri('open_url', { url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Copia texto para a área de transferência, com fallback silencioso. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

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
