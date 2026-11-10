import type { Repositories } from '@lsm/database';
import { AppError, type Clock } from '@lsm/shared';

export const WEB_HOSTS_KEY = 'web-hosts';
const MAX_HOSTS = 32;
/** Um rótulo DNS: sem esquema, porta, caminho ou usuário. */
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/**
 * Aceita o que o usuário costuma colar (`https://painel.exemplo.com/`,
 * `PAINEL.exemplo.com:8443`) e devolve só o hostname canônico.
 */
export function normalizeWebHost(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  let text = value.trim().toLowerCase();
  if (text === '') {
    return null;
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // esquema
  text = text.split('/')[0] ?? ''; // caminho/query
  text = text.replace(/:\d{1,5}$/, ''); // porta
  text = text.replace(/\.$/, ''); // FQDN com ponto final
  return HOSTNAME_PATTERN.test(text) ? text : null;
}

/**
 * Hostnames públicos autorizados a falar com a API além do loopback.
 *
 * Existe para o painel atrás de túnel/reverse proxy: sem a lista, o Engine
 * rejeitaria o `Host` externo (proteção contra DNS rebinding). A lista é
 * explícita porque o `Host` de uma requisição é controlado pelo cliente.
 */
export class WebHosts {
  private cache: string[] | null = null;

  constructor(
    private readonly repositories: Repositories,
    private readonly clock: Clock,
  ) {}

  list(): readonly string[] {
    if (this.cache === null) {
      const stored: unknown = this.repositories.settings.get(WEB_HOSTS_KEY);
      const items = Array.isArray(stored) ? stored : [];
      this.cache = items
        .map((item) => normalizeWebHost(item))
        .filter((item): item is string => item !== null)
        .slice(0, MAX_HOSTS);
    }
    return this.cache;
  }

  replace(input: unknown): string[] {
    if (!Array.isArray(input)) {
      throw new AppError('VALIDATION_ERROR', 'Envie a lista de hosts em "hosts".');
    }
    if (input.length > MAX_HOSTS) {
      throw new AppError('VALIDATION_ERROR', `Máximo de ${String(MAX_HOSTS)} hosts.`);
    }

    const hosts: string[] = [];
    const invalid: string[] = [];
    for (const item of input) {
      const normalized = normalizeWebHost(item);
      if (normalized === null) {
        invalid.push(String(item).slice(0, 120));
        continue;
      }
      if (!hosts.includes(normalized)) {
        hosts.push(normalized);
      }
    }
    if (invalid.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Host inválido: ${invalid.join(', ')}. Informe só o hostname (ex.: painel.exemplo.com).`,
      );
    }

    this.repositories.settings.set(WEB_HOSTS_KEY, hosts, this.clock.nowIso());
    this.cache = hosts;
    return [...hosts];
  }

  allows(hostname: string): boolean {
    return this.list().includes(hostname.toLowerCase());
  }
}
