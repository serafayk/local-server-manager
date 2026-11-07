export interface LineDecoderOptions {
  /** Tamanho máximo de uma linha antes de truncar e descartar o restante. */
  maxLineLength: number;
  onLine: (text: string, truncated: boolean) => void;
}

/**
 * Monta linhas a partir de chunks arbitrários de stdout/stderr.
 *
 * docs/10-LOGGING-MONITORING.md §1: chunks não são linhas completas. Linhas
 * maiores que o limite são truncadas e o restante é descartado até o próximo
 * `\n` — nunca acumulamos buffer ilimitado.
 */
export class LineDecoder {
  private pending = '';
  private discarding = false;
  private readonly maxLineLength: number;
  private readonly onLine: (text: string, truncated: boolean) => void;

  constructor(options: LineDecoderOptions) {
    this.maxLineLength = Math.max(1, options.maxLineLength);
    this.onLine = options.onLine;
  }

  push(chunk: string): void {
    let data = chunk;
    while (data.length > 0) {
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1) {
        this.consumeSegment(data, false);
        return;
      }
      const segment = data.slice(0, newlineIndex);
      data = data.slice(newlineIndex + 1);
      this.consumeSegment(segment, true);
    }
  }

  /** Emite o conteúdo parcial restante. Chamado ao encerrar o stream. */
  flush(): void {
    if (this.discarding) {
      this.discarding = false;
      this.pending = '';
      return;
    }
    if (this.pending.length > 0) {
      const line = stripCarriageReturn(this.pending);
      this.pending = '';
      this.emit(line, false);
    }
  }

  private consumeSegment(segment: string, lineEnded: boolean): void {
    if (this.discarding) {
      if (lineEnded) {
        this.discarding = false;
      }
      return;
    }

    const available = this.maxLineLength - this.pending.length;
    if (segment.length > available) {
      this.pending += segment.slice(0, available);
      const truncatedLine = stripCarriageReturn(this.pending);
      this.pending = '';
      this.emit(truncatedLine, true);
      if (!lineEnded) {
        this.discarding = true;
      }
      return;
    }

    this.pending += segment;
    if (!lineEnded) {
      return;
    }
    const line = stripCarriageReturn(this.pending);
    this.pending = '';
    this.emit(line, false);
  }

  private emit(text: string, truncated: boolean): void {
    if (text.length === 0) {
      return;
    }
    this.onLine(text, truncated);
  }
}

function stripCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}
