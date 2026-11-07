import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'tree-child.mjs')], {
  stdio: 'ignore',
  windowsHide: true,
});

const pidFile = process.env.PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }), 'utf8');
}

console.log(`parent ${process.pid} child ${child.pid}`);
setInterval(() => {}, 1_000);
