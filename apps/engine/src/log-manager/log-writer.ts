import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export interface InstanceLogWriterOptions {
  /** Caminho base do arquivo, ex.: logs/<projectId>/<instanceId>.log */
  basePath: string;
  maxFileSizeMb: number;
  onError?: (error: Error) => void;
  onDrop?: (dropped: number, total: number) => void;
}

/**
 * Escritor JSONL por instância de processo, com rotação por tamanho.
 *
 * Rotação não renomeia arquivo em uso (no Windows isso falha): abre um novo
 * arquivo com sufixo incremental. Retenção/limpeza é responsabilidade de um
 * job posterior (Fase 2), conforme docs/10 §4.
 */
export class InstanceLogWriter {
  private stream: WriteStream | null = null;
  private rotationIndex = 0;
  private bytes = 0;
  private dropped = 0;
  private closed = false;
  private readonly maxBytes: number;
  private readonly maxBufferedBytes = 8 * 1024 * 1024;

  constructor(private readonly options: InstanceLogWriterOptions) {
    this.maxBytes = Math.max(1, options.maxFileSizeMb) * 1024 * 1024;
    mkdirSync(dirname(options.basePath), { recursive: true });
    this.open(0);
  }

  get filePath(): string {
    return this.currentPath;
  }

  get droppedLines(): number {
    return this.dropped;
  }

  write(record: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (this.bytes > 0 && this.bytes + size > this.maxBytes) {
      this.rotate();
    }
    this.bytes += size;

    const stream = this.stream;
    if (!stream) {
      return;
    }
    if (stream.writableLength > this.maxBufferedBytes) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1_000 === 0) {
        this.options.onDrop?.(this.dropped, this.dropped);
      }
      return;
    }
    stream.write(line);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const stream = this.stream;
    this.stream = null;
    if (!stream) {
      return;
    }
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  private currentPath = '';

  private open(index: number): void {
    this.rotationIndex = index;
    this.currentPath = index === 0 ? this.options.basePath : `${this.options.basePath}.${index}`;
    this.bytes = this.readExistingSize(this.currentPath);
    const stream = createWriteStream(this.currentPath, { flags: 'a', highWaterMark: 64 * 1024 });
    stream.on('error', (error: Error) => {
      this.stream = null;
      this.options.onError?.(error);
    });
    this.stream = stream;
  }

  private rotate(): void {
    const previous = this.stream;
    this.stream = null;
    if (previous) {
      previous.end();
    }
    this.open(this.rotationIndex + 1);
  }

  private readExistingSize(filePath: string): number {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  }
}
