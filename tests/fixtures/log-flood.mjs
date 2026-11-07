const lines = Number(process.env.LINES ?? 20);

for (let index = 1; index <= lines; index += 1) {
  console.log(`out ${index}`);
  console.error(`err ${index}`);
}

setInterval(() => {}, 1_000);
