import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCommand,
  formatDateTime,
  formatDuration,
  formatTime,
  formatUptime,
  shortId,
} from './format';

describe('format', () => {
  it('formata duração em faixas', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('calcula uptime a partir do início', () => {
    const now = Date.parse('2026-01-01T01:00:00.000Z');
    expect(formatUptime('2026-01-01T00:59:30.000Z', now)).toBe('30s');
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime('data-invalida')).toBe('—');
  });

  it('formata bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(15 * 1_024 * 1_024)).toBe('15 MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('formata data/hora e ids', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('2026-01-01T12:00:00.000Z')).toContain('2026');
    expect(formatTime('2026-01-01T12:34:56.000Z')).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(shortId('1234567890', 4)).toBe('1234');
    expect(shortId(null)).toBe('—');
  });

  it('monta comando com aspas quando necessário', () => {
    expect(formatCommand('node', ['server.js'])).toBe('node server.js');
    expect(formatCommand('C:\\Program Files\\nodejs\\node.exe', ['a b'])).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "a b"',
    );
  });
});
