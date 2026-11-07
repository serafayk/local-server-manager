/**
 * Mascaramento heurístico de dados sensíveis.
 *
 * docs/10-LOGGING-MONITORING.md §8 deixa explícito que mascaramento por
 * padrões não é garantia. O objetivo aqui é reduzir vazamento acidental,
 * não substituir a decisão do usuário de não logar segredos.
 */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|session)/i;

export const DEFAULT_MASK_PATTERNS: readonly string[] = [
  '(password|passwd|secret|token|api[_-]?key)\\s*[:=]\\s*("[^"]*"|[^\\s,;]+)',
  '(authorization)\\s*[:=]\\s*(bearer\\s+[^\\s,;]+)',
];

const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[MAX_DEPTH]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return result;
}

/**
 * Aplica os padrões configurados mais os padrões default sobre texto de log.
 * Padrões inválidos são ignorados (a validação Zod já os rejeita na entrada).
 */
export function redactText(text: string, patterns: readonly string[] = []): string {
  let output = text;
  for (const pattern of [...DEFAULT_MASK_PATTERNS, ...patterns]) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      continue;
    }
    output = output.replace(regex, (match: string) => {
      const separatorIndex = match.search(/[:=]/);
      const keyPart = separatorIndex >= 0 ? match.slice(0, separatorIndex) : match;
      return `${keyPart}=${REDACTED}`;
    });
  }
  return output;
}
