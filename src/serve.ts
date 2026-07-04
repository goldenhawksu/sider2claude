import server from './main';

Bun.serve({
  ...server,
  port: Number(server.port),
});
