import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 0);
const host = process.env.HOST ?? '127.0.0.1';

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`listening on ${actualPort}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
