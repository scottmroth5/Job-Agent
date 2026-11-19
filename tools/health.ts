// A health check for a process with no web server of its own (v3 Phase 7: a worker or the scheduler): GET /healthz on
// 127.0.0.1 answers 200 while check() says the process is working, 503 when not. Docker's healthcheck and deploy.sh
// ask it from inside the container; it is never published. It says only ok and the service's name.
import { createServer } from 'node:http';

export function serveHealth({ port, service, check, host = '127.0.0.1' }: { port: number; service: string; check: () => boolean; host?: string }) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const ok = (() => {
      try {
        return check();
      } catch {
        return false;
      }
    })();
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok, service }));
  });
  // Not unref: in a worker or the scheduler every other timer is, and this server is what keeps the process running.
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
