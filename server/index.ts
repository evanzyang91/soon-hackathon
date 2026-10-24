// Entry: one HTTPS server for static web (Vite middleware in dev, dist/ in prod), /api, and /ws.
// WP B owns server/https.ts + server/relay.ts; WP C owns server/pipeline/routes.ts. This file
// only wires them together — keep it thin.
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { env, keyPresence } from './env.ts';
import { loadOrCreateCerts, lanAddresses } from './https.ts';
import { attachRelay, newRoom } from './relay.ts';
import { handlePipelineRequest, resumePipelines } from './pipeline/routes.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css',
};

async function serveFile(root: string, urlPath: string, res: import('node:http').ServerResponse) {
  const safe = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, safe);
  if (!file.startsWith(root)) return false;
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': s.size,
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes',
    });
    res.end(await readFile(file));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const certs = await loadOrCreateCerts();
  const dev = process.env.NODE_ENV !== 'production';
  const vite = dev
    ? await (await import('vite')).createServer({
        configFile: new URL('../web/vite.config.ts', import.meta.url).pathname,
        server: { middlewareMode: true, https: certs, hmr: { server: undefined } },
      })
    : null;

  const server = createHttpsServer(certs, async (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    const p = url.pathname;
    try {
      if (p === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, mock: env.mock, keys: keyPresence() }));
      }
      if (p === '/api/rooms/new') {
        const room = newRoom();
        const host = req.headers.host ?? `localhost:${env.port}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ room, phoneUrl: `https://${host}/phone.html?room=${room}` }));
      }
      if (p.startsWith('/api/')) {
        if (await handlePipelineRequest(req, res, url)) return;
        res.writeHead(404);
        return res.end('not found');
      }
      if (p.startsWith('/projects/')) {
        if (await serveFile(env.dataDir, p.slice('/projects/'.length), res)) return;
        res.writeHead(404);
        return res.end('not found');
      }
      if (vite) return vite.middlewares(req, res, () => {
        res.writeHead(404);
        res.end('not found');
      });
      const dist = new URL('../dist/', import.meta.url).pathname;
      if (await serveFile(dist, p === '/' ? '/index.html' : p, res)) return;
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end('server error');
    }
  });

  attachRelay(server, { viteHmr: vite?.ws });
  // Pick up projects whose pipeline was interrupted by a previous process exit.
  Promise.resolve(resumePipelines()).catch((e) => console.error('resume failed', e));
  server.listen(env.port, '0.0.0.0', () => {
    console.log(`\nPreviz Stage ${env.mock ? '(MOCK)' : ''}`);
    console.log(`  laptop: https://localhost:${env.port}/`);
    for (const ip of lanAddresses()) console.log(`  phone:  https://${ip}:${env.port}/phone.html`);
    console.log('  (accept the self-signed certificate on both devices once)\n');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
