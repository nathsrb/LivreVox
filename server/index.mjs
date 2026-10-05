import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiTts } from './gemini.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

async function loadEnvFile() {
  try {
    const raw = await readFile(path.join(root, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Le fichier .env est optionnel : les variables système restent utilisables.
  }
}

await loadEnvFile();

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const maxBodyBytes = 512 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) throw new Error('Requête trop volumineuse.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
  }[ext] || 'application/octet-stream';
}

async function serveStatic(req, res, pathname) {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const candidate = path.resolve(distDir, `.${normalized}`);
  if (!candidate.startsWith(distDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(distDir, 'index.html');
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Content-Length': body.length,
      'Cache-Control': filePath.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'Frontend non construit. Lance "npm run dev" pour le développement ou "npm run build && npm start" pour la production.'
    );
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        provider: process.env.GEMINI_API_KEY ? 'gemini' : 'local-fallback',
        ttsConfigured: Boolean(process.env.GEMINI_API_KEY),
        model: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tts') {
      if (!process.env.GEMINI_API_KEY) {
        sendJson(res, 503, {
          error: 'Gemini n’est pas configuré. Ajoute GEMINI_API_KEY dans le fichier .env.',
        });
        return;
      }
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) {
        sendJson(res, 400, { error: 'Texte vide.' });
        return;
      }
      if (text.length > 20_000) {
        sendJson(res, 413, {
          error: 'Segment trop long. LivreVox doit découper le texte avant la synthèse.',
        });
        return;
      }

      const result = await geminiTts(text, {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_TTS_MODEL,
        voice: process.env.GEMINI_TTS_VOICE,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Route API introuvable.' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Erreur serveur inconnue.',
    });
  }
});

server.listen(port, host, () => {
  console.log(`LivreVox API prête sur http://${host}:${port}`);
  if (!process.env.GEMINI_API_KEY)
    console.log('GEMINI_API_KEY absente : Piper restera disponible en secours.');
});
