console.log('boot');
console.error('stderr-line');

const delay = Number(process.env.CRASH_AFTER_MS ?? 100);
const code = Number(process.env.EXIT_CODE ?? 3);

setTimeout(() => {
  console.log('crashing');
  process.exit(code);
}, delay);
