const size = Number(process.env.LINE_SIZE ?? 20_000);
process.stdout.write(`${'x'.repeat(size)}\n`);
process.stdout.write('after-long-line\n');
setInterval(() => {}, 1_000);
