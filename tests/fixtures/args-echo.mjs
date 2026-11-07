console.log(
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    foo: process.env.FOO ?? null,
  }),
);
setInterval(() => {}, 1_000);
