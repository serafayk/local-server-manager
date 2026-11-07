import { createEngine } from './engine';

const engine = createEngine();
let stopping = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await engine.shutdown(reason);
    process.exitCode = exitCode;
  } catch (error) {
    engine.logger.error('Falha no encerramento do Engine', { reason }, error);
    process.exitCode = 1;
  } finally {
    // Garante que nenhum handle (pipe, timers) mantenha o processo vivo.
    process.exit(process.exitCode ?? 0);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('uncaughtException', (error) => {
  engine.logger.error('uncaughtException', {}, error);
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  engine.logger.error('unhandledRejection', {}, reason);
});

try {
  await engine.start();
} catch (error) {
  engine.logger.error('Falha ao iniciar o Engine', {}, error);
  process.exit(1);
}
