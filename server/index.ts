// Entry: one HTTPS server for static web (Vite middleware in dev, dist/ in prod), /api, and /ws.
// WP B owns server/https.ts + server/relay.ts; WP C owns server/pipeline/routes.ts. This file
// only wires them together — keep it thin.
import { createReadStream } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { ViteDevServer } from 'vite';
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
  '.jpg': 'image/jpeg', // also chat uploads (uploads/<id>.jpg), shot frames (scene-<n>/shots/<id>.jpg)
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', // Marble thumbnails, chat uploads
  '.gltf': 'model/gltf+json',
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

// /models/<uid>/model.glb | model.json: the found-model library (server/pipeline/models.ts). Only
// those two names under a 32-hex id, so nothing outside MODELS_LIBRARY_DIR is reachable; a uid's
// files never change once written, so browsers may keep them.
const MODEL_PATH = /^\/models\/([0-9a-f]{32})\/(model\.glb|model\.json)$/;
async function serveModel(urlPath: string, res: import('node:http').ServerResponse) {
  const m = MODEL_PATH.exec(urlPath);
  if (!m) return false;
  const file = join(env.modelsLibraryDir, m[1]!, m[2]!);
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    res.writeHead(200, {
      'content-type': m[2] === 'model.glb' ? 'model/gltf-binary' : 'application/json',
      'content-length': s.size,
      'cache-control': 'public, max-age=604800, immutable',
    });
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const certs = await loadOrCreateCerts();
  const dev = process.env.NODE_ENV !== 'production';
  // Vite is created after the HTTPS server so its HMR WebSocket can ride on the same origin the
  // phone already trusted. HMR_PORT forces a separate port instead (two checkouts side by side).
  let vite: ViteDevServer | null = null;

  const server = createHttpsServer(certs, async (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    const p = url.pathname;
    try {
      if (p === '/cert.pem') {
        // iOS: open this URL in Safari to install the certificate profile instead of tapping through.
        res.writeHead(200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="previz-stage.pem"',
        });
        return res.end(certs.cert);
      }
      if (p === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, mock: env.mock, keys: keyPresence() }));
      }
      if (p === '/api/rooms/new') {
        // ?room=ABCD re-issues the LAN phone URL for a code the laptop kept across a reload
        // (the relay recreates rooms on hello, so the code itself needs no server state).
        const kept = url.searchParams.get('room') ?? '';
        const room = /^[A-Z0-9]{4,6}$/.test(kept) ? kept : newRoom();
        // A phone cannot reach "localhost"; prefer the first LAN address when the laptop is local.
        const reqHost = req.headers.host ?? `localhost:${env.port}`;
        const [name, port = String(env.port)] = reqHost.split(':');
        const lan = lanAddresses()[0];
        const host = (name === 'localhost' || name === '127.0.0.1') && lan ? `${lan}:${port}` : reqHost;
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
      if (p.startsWith('/models/')) {
        if (await serveModel(p, res)) return;
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

  if (dev) {
    const hmrPort = process.env.HMR_PORT ? Number(process.env.HMR_PORT) : undefined;
    vite = await (await import('vite')).createServer({
      configFile: new URL('../web/vite.config.ts', import.meta.url).pathname,
      server: {
        middlewareMode: true,
        https: certs,
        ws: hmrPort ? { port: hmrPort } : { server },
      },
    });
  }
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
