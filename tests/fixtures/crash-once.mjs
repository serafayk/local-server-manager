import { existsSync, writeFileSync } from 'node:fs';

const marker = process.env.MARKER_FILE;

if (marker && !existsSync(marker)) {
  writeFileSync(marker, 'crashed', 'utf8');
  console.error('first run crash');
  process.exit(7);
}

console.log('running stable');
setInterval(() => {}, 1_000);
