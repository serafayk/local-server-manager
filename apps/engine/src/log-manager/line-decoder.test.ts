import { describe, expect, it } from 'vitest';
import { LineDecoder } from './line-decoder';

function collect(maxLineLength = 10) {
  const lines: Array<{ text: string; truncated: boolean }> = [];
  const decoder = new LineDecoder({
    maxLineLength,
    onLine: (text, truncated) => lines.push({ text, truncated }),
  });
  return { decoder, lines };
}

describe('LineDecoder', () => {
  it('monta linha dividida entre chunks', () => {
    const { decoder, lines } = collect(100);
    decoder.push('hel');
    decoder.push('lo');
    expect(lines).toHaveLength(0);
    decoder.push('\n');
    expect(lines).toEqual([{ text: 'hello', truncated: false }]);
  });

  it('separa múltiplas linhas no mesmo chunk', () => {
    const { decoder, lines } = collect(100);
    decoder.push('a\nb\nc');
    expect(lines.map((line) => line.text)).toEqual(['a', 'b']);
    decoder.flush();
    expect(lines.map((line) => line.text)).toEqual(['a', 'b', 'c']);
  });

  it('remove CR de CRLF', () => {
    const { decoder, lines } = collect(100);
    decoder.push('linha\r\n');
    expect(lines[0]?.text).toBe('linha');
  });

  it('ignora linhas vazias', () => {
    const { decoder, lines } = collect(100);
    decoder.push('\n\n\n');
    expect(lines).toHaveLength(0);
  });

  it('trunca linha maior que o limite', () => {
    const { decoder, lines } = collect(5);
    decoder.push('123456789\nok\n');
    expect(lines).toEqual([
      { text: '12345', truncated: true },
      { text: 'ok', truncated: false },
    ]);
  });

  it('descarta o restante da linha após truncar', () => {
    const { decoder, lines } = collect(5);
    decoder.push('123456789');
    expect(lines).toEqual([{ text: '12345', truncated: true }]);
    decoder.push('resto-descartado\nok\n');
    expect(lines).toEqual([
      { text: '12345', truncated: true },
      { text: 'ok', truncated: false },
    ]);
  });

  it('flush emite conteúdo parcial', () => {
    const { decoder, lines } = collect(100);
    decoder.push('parcial');
    decoder.flush();
    expect(lines).toEqual([{ text: 'parcial', truncated: false }]);
  });

  it('não vaza texto entre linhas truncadas consecutivas', () => {
    const { decoder, lines } = collect(3);
    decoder.push('aaaaaaaa\nbbbbbbbb\nccc\n');
    expect(lines).toEqual([
      { text: 'aaa', truncated: true },
      { text: 'bbb', truncated: true },
      { text: 'ccc', truncated: false },
    ]);
  });
});
