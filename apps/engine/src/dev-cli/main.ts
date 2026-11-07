import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AppError, isAppError } from '@lsm/shared';
import { createEngine, type Engine } from '../bootstrap/engine';
import { executeLine } from './commands';

interface CliArguments {
  dataDir?: string;
  execFile?: string;
  singleInstance: boolean;
  help: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const result: CliArguments = { singleInstance: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--data-dir': {
        const value = argv[index + 1];
        if (!value) {
          throw new AppError('VALIDATION_ERROR', '--data-dir exige um caminho.');
        }
        result.dataDir = value;
        index += 1;
        break;
      }
      case '--exec-file': {
        const value = argv[index + 1];
        if (!value) {
          throw new AppError('VALIDATION_ERROR', '--exec-file exige um caminho.');
        }
        result.execFile = value;
        index += 1;
        break;
      }
      case '--no-single-instance':
        result.singleInstance = false;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new AppError('VALIDATION_ERROR', `Argumento desconhecido: ${argument}`);
    }
  }
  return result;
}

function printUsage(): void {
  console.log(
    [
      'Uso: pnpm cli [--data-dir <caminho>] [--exec-file <arquivo>] [--no-single-instance]',
      '',
      'Sem --exec-file, abre um REPL. Com --exec-file, executa cada linha do arquivo.',
      'Comandos: digite "help" no REPL.',
    ].join('\n'),
  );
}

async function runRepl(engine: Engine): Promise<void> {
  const readline = createInterface({ input: stdin, output: stdout });
  readline.setPrompt('lsm> ');
  readline.on('SIGINT', () => {
    console.log('');
    readline.close();
  });

  readline.prompt();
  for await (const line of readline) {
    const outcome = await executeLine({ engine }, line);
    if (outcome === 'exit') {
      break;
    }
    readline.prompt();
  }
  readline.close();
}

async function runScript(engine: Engine, filePath: string): Promise<void> {
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    console.log(`> ${line}`);
    const outcome = await executeLine({ engine }, line);
    if (outcome === 'exit') {
      return;
    }
  }
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const engine = createEngine({
    dataDir: args.dataDir,
    singleInstance: args.singleInstance,
  });

  try {
    await engine.start();
  } catch (error) {
    if (isAppError(error)) {
      console.error(`ERRO [${error.code}] ${error.message}`);
    } else {
      console.error(`ERRO ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }

  console.log('Local Server Manager — Engine (CLI de desenvolvimento)');
  console.log(`pid=${process.pid} dataDir=${engine.paths.root}`);
  console.log(`projetos=${engine.supervisor.listProjects().length}`);
  console.log('Digite "help" para os comandos.\n');

  try {
    if (args.execFile) {
      await runScript(engine, args.execFile);
    } else {
      await runRepl(engine);
    }
    return 0;
  } finally {
    await engine.shutdown('cli-exit');
  }
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  if (isAppError(error)) {
    console.error(`ERRO [${error.code}] ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
}
