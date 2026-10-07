import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { zipSync } from 'fflate';
import { createHash, createHmac } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env if present and override placeholder values
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key] || process.env[key]?.startsWith('MY_')) {
          process.env[key] = val.trim();
        }
      }
    }
  }
} catch {
  // ignore
}

const PORT = 3000;
const HOST = '0.0.0.0';
const STORAGE_DIR = path.join(__dirname, '.cloud_storage');
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

type ProviderName = 'gemini' | 'deepinfra' | 'aws-polly';

type ProviderCredentials = {
  provider: ProviderName;
  apiKey: string;
  apiSecret?: string;
  region?: string;
};

function normalizeProvider(value?: string): ProviderName {
  if (value === 'deepinfra' || value === 'aws-polly') return value;
  return 'gemini';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

async function synthesizeGemini(text: string, voice: string, apiKey: string) {
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } },
          },
        },
      }),
    }
  );
  if (!response.ok) throw new Error(`Gemini TTS ${response.status}: ${await response.text()}`);
  const payload = await response.json() as any;
  const part = payload?.candidates?.[0]?.content?.parts?.find((item: any) => item?.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error('Gemini n’a renvoyé aucun audio.');
  return {
    buffer: Buffer.from(part.inlineData.data, 'base64'),
    mimeType: part.inlineData.mimeType || 'audio/wav',
    extension: 'wav',
  };
}

async function synthesizeDeepInfra(text: string, voice: string, apiKey: string) {
  const response = await fetch('https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      tts_response_format: 'mp3',
      preset_voice: [voice && voice !== 'Kore' ? voice : 'ff_siwis'],
      speed: 1,
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`DeepInfra Kokoro ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { audio?: string };
  if (!payload.audio) throw new Error('DeepInfra n’a renvoyé aucun audio.');
  if (/^https?:\/\//.test(payload.audio)) {
    const audio = await fetch(payload.audio);
    if (!audio.ok) throw new Error('Impossible de récupérer l’audio DeepInfra.');
    return { buffer: Buffer.from(await audio.arrayBuffer()), mimeType: 'audio/mpeg', extension: 'mp3' };
  }
  const clean = payload.audio.includes(',') ? payload.audio.slice(payload.audio.indexOf(',') + 1) : payload.audio;
  return { buffer: Buffer.from(clean, 'base64'), mimeType: 'audio/mpeg', extension: 'mp3' };
}

async function synthesizePolly(text: string, voice: string, accessKeyId: string, secretAccessKey: string, region: string) {
  const host = `polly.${region}.amazonaws.com`;
  const endpoint = `https://${host}/v1/speech`;
  const body = JSON.stringify({
    Engine: 'neural',
    LanguageCode: 'fr-FR',
    OutputFormat: 'mp3',
    Text: text,
    TextType: 'text',
    VoiceId: voice && voice !== 'Kore' ? voice : 'Lea',
  });
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = ['POST', '/v1/speech', '', canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n');
  const scope = `${dateStamp}/${region}/polly/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'polly');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Amz-Date': amzDate,
      Authorization: authorization,
    },
    body,
  });
  if (!response.ok) throw new Error(`Amazon Polly ${response.status}: ${await response.text()}`);
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg', extension: 'mp3' };
}

async function synthesizeProviderSpeech(text: string, voice: string, credentials: ProviderCredentials) {
  if (!credentials.apiKey) throw new Error('Clé API manquante.');
  if (credentials.provider === 'deepinfra') return synthesizeDeepInfra(text, voice, credentials.apiKey);
  if (credentials.provider === 'aws-polly') {
    if (!credentials.apiSecret) throw new Error('AWS Secret Access Key manquante.');
    return synthesizePolly(text, voice, credentials.apiKey, credentials.apiSecret, credentials.region || 'eu-west-3');
  }
  return synthesizeGemini(text, voice, credentials.apiKey);
}

async function generateTextWithProvider(prompt: string, credentials: ProviderCredentials): Promise<string> {
  if (credentials.provider === 'aws-polly') {
    throw new Error('Amazon Polly est un service vocal uniquement. Utilise Gemini ou DeepInfra pour les résumés IA.');
  }
  if (credentials.provider === 'deepinfra') {
    const response = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.DEEPINFRA_TEXT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!response.ok) throw new Error(`DeepInfra texte ${response.status}: ${await response.text()}`);
    const payload = await response.json() as any;
    return payload?.choices?.[0]?.message?.content || '';
  }
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(credentials.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    }
  );
  if (!response.ok) throw new Error(`Gemini texte ${response.status}: ${await response.text()}`);
  const payload = await response.json() as any;
  return payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
}

type CloudChapter = {
  id: string;
  index: number;
  title: string;
  text: string;
  words: number;
  estimatedMinutes: number;
  audioPath?: string;
  audioDuration?: number;
  hasAudio: boolean;
};

type CloudJob = {
  id: string;
  title: string;
  name: string;
  size: number;
  status: 'uploading' | 'processing' | 'ready' | 'generating_audio' | 'complete' | 'failed';
  pages: number;
  processingProgress: number;
  audioReady: number;
  ttsConfigured: boolean;
  ttsProvider: string;
  error?: string;
  chapters: CloudChapter[];
  createdAt: number;
  updatedAt: number;
};

// In-memory job registry backed by disk
const jobs = new Map<string, CloudJob>();
const uploadChunks = new Map<string, { totalParts: number; parts: Map<number, Buffer> }>();

function jobPath(jobId: string): string {
  return path.join(STORAGE_DIR, `job_${jobId}.json`);
}

function audioPathFor(jobId: string, chapterId: string): string {
  const dir = path.join(STORAGE_DIR, 'audio', jobId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${chapterId}.wav`);
}

function saveJobToDisk(job: CloudJob) {
  try {
    fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save job to disk:', err);
  }
}

function loadJobsFromDisk() {
  try {
    const files = fs.readdirSync(STORAGE_DIR);
    for (const f of files) {
      if (f.startsWith('job_') && f.endsWith('.json')) {
        const raw = fs.readFileSync(path.join(STORAGE_DIR, f), 'utf8');
        const job = JSON.parse(raw) as CloudJob;
        // Verify audio file existence
        for (const ch of job.chapters) {
          const aPath = audioPathFor(job.id, ch.id);
          ch.hasAudio = fs.existsSync(aPath);
          if (ch.hasAudio) ch.audioPath = `/api/cloud/audio/${job.id}/${ch.id}`;
        }
        job.audioReady = job.chapters.filter(c => c.hasAudio).length;
        jobs.set(job.id, job);
      }
    }
  } catch (err) {
    console.warn('No previous cloud jobs loaded:', err);
  }
}

loadJobsFromDisk();

function countWords(str: string): number {
  return str.trim() ? str.trim().split(/\s+/).length : 0;
}

/**
 * Concatenates multiple WAV buffers generated by Gemini TTS into a single valid RIFF WAV buffer.
 */
function concatenateWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  const first = buffers[0];
  if (first.length < 44) return Buffer.concat(buffers);

  let totalDataLength = 0;
  const pcmChunks: Buffer[] = [];
  for (const buf of buffers) {
    if (buf.length > 44) {
      const pcm = buf.subarray(44);
      pcmChunks.push(pcm);
      totalDataLength += pcm.length;
    }
  }

  const out = Buffer.alloc(44 + totalDataLength);
  first.copy(out, 0, 0, 44);
  out.writeUInt32LE(36 + totalDataLength, 4);
  out.writeUInt32LE(totalDataLength, 40);

  let offset = 44;
  for (const chunk of pcmChunks) {
    chunk.copy(out, offset);
    offset += chunk.length;
  }

  return out;
}

/**
 * Splits text into paragraphs suitable for TTS narration (up to 7500 chars per segment)
 * This avoids dividing normal chapters into too many chunks and hitting Gemini rate limits.
 */
function splitTextForTts(text: string, maxLen = 7500): string[] {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length <= maxLen) {
      current = current ? current + '\n\n' + p : p;
    } else {
      if (current) chunks.push(current);
      if (p.length > maxLen) {
        // Break sentences
        const sentences = p.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [p];
        let sub = '';
        for (const s of sentences) {
          if ((sub + ' ' + s.trim()).length <= maxLen) {
            sub = sub ? sub + ' ' + s.trim() : s.trim();
          } else {
            if (sub) chunks.push(sub);
            sub = s.trim();
          }
        }
        if (sub) chunks.push(sub);
        current = '';
      } else {
        current = p;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.trim()];
}

/**
 * Synthesizes a chapter with the selected provider. Long chapters are split server-side.
 */
async function synthesizeSpeech(
  text: string,
  voiceName: string,
  credentials: ProviderCredentials
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const segments = splitTextForTts(text).filter(Boolean);
  const outputs: Array<{ buffer: Buffer; mimeType: string; extension: string }> = [];
  for (let i = 0; i < segments.length; i += 1) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        outputs.push(await synthesizeProviderSpeech(segments[i], voiceName, credentials));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
  }
  if (!outputs.length) throw new Error('Aucun audio généré.');
  const first = outputs[0];
  if (first.mimeType.includes('wav')) {
    return { ...first, buffer: concatenateWavBuffers(outputs.map(item => item.buffer)) };
  }
  return { ...first, buffer: Buffer.concat(outputs.map(item => item.buffer)) };
}

/**
 * Legacy cloud PDF extraction. The normal LivreVox flow now extracts PDF text locally.
 */
async function extractBookFromPdf(
  _pdfBuffer: Buffer,
  fileName: string
): Promise<{ bookTitle: string; chapters: Array<{ title: string; text: string }> }> {
  throw new Error(
    `L’analyse cloud directe de ${fileName} est désactivée. Importe le PDF dans l’interface LivreVox : le texte est extrait localement, sans dépendre de Google AI Studio.`
  );
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '65mb' }));
  app.use(express.urlencoded({ extended: true, limit: '65mb' }));

  // Cross-Origin isolation for WebAssembly SIMD and Workers
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });

  // Capabilities API
  app.get('/api/cloud/capabilities', (req: Request, res: Response) => {
    const provider = normalizeProvider((req.headers['x-tts-provider'] as string) || process.env.TTS_PROVIDER);
    const hasRequestKey = Boolean(req.headers['x-api-key']);
    const hasEnvKey =
      provider === 'deepinfra'
        ? Boolean(process.env.DEEPINFRA_API_KEY)
        : provider === 'aws-polly'
          ? Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
          : Boolean(process.env.GEMINI_API_KEY);
    res.json({
      cloud: false,
      mode: 'Multi-provider TTS',
      ttsConfigured: hasRequestKey || hasEnvKey,
      ttsProvider: provider,
      chunkUpload: false,
      ocr: false,
      providers: ['deepinfra', 'gemini', 'aws-polly'],
    });
  });

  app.get('/api/health', (req: Request, res: Response) => {
    const provider = normalizeProvider((req.headers['x-tts-provider'] as string) || process.env.TTS_PROVIDER);
    const configured =
      Boolean(req.headers['x-api-key']) ||
      (provider === 'deepinfra'
        ? Boolean(process.env.DEEPINFRA_API_KEY)
        : provider === 'aws-polly'
          ? Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
          : Boolean(process.env.GEMINI_API_KEY));
    res.json({ ok: true, provider: configured ? provider : 'local-fallback', ttsConfigured: configured });
  });

  app.post('/api/tts', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const provider = normalizeProvider(
        (body.provider as string) ||
        (req.headers['x-tts-provider'] as string) ||
        process.env.TTS_PROVIDER
      );
      const apiKey = String(
        body.apiKey ||
        req.headers['x-api-key'] ||
        (provider === 'deepinfra'
          ? process.env.DEEPINFRA_API_KEY
          : provider === 'aws-polly'
            ? process.env.AWS_ACCESS_KEY_ID
            : process.env.GEMINI_API_KEY) ||
        ''
      ).trim();
      const apiSecret = String(
        body.apiSecret ||
        req.headers['x-api-secret'] ||
        process.env.AWS_SECRET_ACCESS_KEY ||
        ''
      ).trim();
      const region = String(
        body.region ||
        req.headers['x-aws-region'] ||
        process.env.AWS_REGION ||
        'eu-west-3'
      ).trim();
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return res.status(400).json({ error: 'Texte vide.' });
      if (!apiKey) return res.status(503).json({ error: 'Identifiant API manquant pour le fournisseur sélectionné.' });

      const defaultVoice = provider === 'deepinfra' ? 'ff_siwis' : provider === 'aws-polly' ? 'Lea' : 'Kore';
      const voice = String(body.voice || defaultVoice);
      const result = await synthesizeSpeech(text, voice, { provider, apiKey, apiSecret, region });

      res.json({
        audio: result.buffer.toString('base64'),
        mimeType: result.mimeType,
        provider,
        voice,
      });
    } catch (err: any) {
      console.error('Erreur /api/tts:', err);
      const isQuota = /429|RESOURCE_EXHAUSTED|quota|throttl/i.test(err?.message || '');
      res.status(isQuota ? 429 : 500).json({
        error: err?.message || 'Erreur de synthèse vocale.',
        isQuota,
      });
    }
  });

  app.post('/api/validate-key', async (req: Request, res: Response) => {
    try {
      const provider = normalizeProvider(req.body?.provider || (req.headers['x-tts-provider'] as string));
      const apiKey = String(req.body?.apiKey || req.headers['x-api-key'] || '').trim();
      const apiSecret = String(req.body?.apiSecret || req.headers['x-api-secret'] || '').trim();
      const region = String(req.body?.region || req.headers['x-aws-region'] || 'eu-west-3').trim();
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Veuillez saisir vos identifiants API.' });
      if (provider === 'aws-polly' && !apiSecret) {
        return res.status(400).json({ ok: false, error: 'AWS Secret Access Key manquante.' });
      }
      await synthesizeProviderSpeech('Test de connexion LivreVox.', provider === 'deepinfra' ? 'ff_siwis' : provider === 'aws-polly' ? 'Lea' : 'Kore', {
        provider,
        apiKey,
        apiSecret,
        region,
      });
      return res.json({ ok: true, provider, message: `Connexion ${provider} validée.` });
    } catch (err: any) {
      console.warn('Validation API échouée:', err);
      return res.status(400).json({ ok: false, error: err?.message || 'Identifiants API invalides ou sans quota.' });
    }
  });

  // Push local repository to GitHub
  app.post('/api/github/push', async (req: Request, res: Response) => {
    try {
      const { token, repoUrl = 'https://github.com/nathsrb/LivreVox.git' } = req.body as {
        token?: string;
        repoUrl?: string;
      };
      const cleanToken = (token || process.env.GITHUB_TOKEN || '').trim();
      if (!cleanToken) {
        return res.status(400).json({
          ok: false,
          error: 'Veuillez renseigner votre jeton d’accès GitHub (Personal Access Token).',
        });
      }

      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/i);
      if (!match) {
        return res.status(400).json({ ok: false, error: 'URL de dépôt GitHub invalide.' });
      }
      const owner = match[1];
      const repo = match[2];
      const authedUrl = `https://${cleanToken}@github.com/${owner}/${repo}.git`;

      const { exec } = await import('node:child_process');
      const util = await import('node:util');
      const execAsync = util.promisify(exec);

      // Make sure main branch is active and commit is ready
      await execAsync('git branch -M main');
      // Push with authentication
      const { stdout, stderr } = await execAsync(`git push -u "${authedUrl}" main`);

      return res.json({
        ok: true,
        message: '✓ Dépôt GitHub synchronisé avec succès sur la branche main !',
        output: (stdout || stderr || '').trim(),
      });
    } catch (err: any) {
      console.error('GitHub push error:', err);
      const msg = err?.message || 'Erreur lors du push GitHub';
      if (
        msg.includes('Authentication failed') ||
        msg.includes('403') ||
        msg.includes('Bad credentials') ||
        msg.includes('could not read Username')
      ) {
        return res.status(401).json({
          ok: false,
          error:
            'Authentification GitHub échouée : vérifiez que votre Personal Access Token GitHub est valide et dispose de la permission « repo » (ou Contents Read & Write).',
        });
      }
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // Direct download route for the current AI Studio codebase.
  // Builds the ZIP at request time so the button works even when no prebuilt archive exists.
  app.get('/api/download-zip', (_req: Request, res: Response) => {
    try {
      const entries: Record<string, Uint8Array> = {};
      const ignoredDirs = new Set([
        'node_modules', '.git', 'dist', '.cloud_storage', '.vite', '.cache', 'coverage', '.next', '.netlify'
      ]);
      const ignoredFiles = new Set(['Auralis-LivreVox-code.zip', 'auralis-source-code.zip']);

      function addDirectory(dir: string, relativeDir = '') {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (item.name.startsWith('.') && item.name !== '.env.example' && item.name !== '.gitignore' && item.name !== '.github') {
            continue;
          }
          if (item.isDirectory() && ignoredDirs.has(item.name)) continue;
          if (item.isFile() && ignoredFiles.has(item.name)) continue;

          const absolutePath = path.join(dir, item.name);
          const archivePath = path.posix.join(relativeDir, item.name);

          if (item.isDirectory()) {
            addDirectory(absolutePath, archivePath);
          } else if (item.isFile()) {
            const stat = fs.statSync(absolutePath);
            if (stat.size <= 25 * 1024 * 1024) {
              entries[archivePath] = new Uint8Array(fs.readFileSync(absolutePath));
            }
          }
        }
      }

      addDirectory(__dirname);
      if (Object.keys(entries).length === 0) {
        return res.status(500).json({ error: 'Aucun fichier source à ajouter au ZIP.' });
      }

      const zipped = zipSync(entries, { level: 6 });
      const buffer = Buffer.from(zipped);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="Auralis-LivreVox-code.zip"',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch (err: any) {
      console.error('Erreur /api/download-zip:', err);
      res.status(500).json({ error: err?.message || 'Impossible de générer le ZIP du code.' });
    }
  });

  // Generate structured AI book summary for chapter (Auralis AI Assistant)
  app.post('/api/chapters/summary', async (req: Request, res: Response) => {
    try {
      const { chapterText, chapterTitle, bookTitle, previousChaptersContext, customApiKey, provider: requestedProvider } = req.body as {
        chapterText?: string;
        chapterTitle?: string;
        bookTitle?: string;
        previousChaptersContext?: string;
        customApiKey?: string;
        provider?: string;
      };

      if (!chapterText || !chapterText.trim()) {
        return res.status(400).json({ error: 'Le texte du chapitre est requis pour générer le résumé.' });
      }

      const provider = normalizeProvider(
        requestedProvider ||
        (req.headers['x-tts-provider'] as string) ||
        process.env.TTS_PROVIDER
      );
      const apiKey = String(
        (req.headers['x-api-key'] as string) ||
        customApiKey ||
        (provider === 'deepinfra' ? process.env.DEEPINFRA_API_KEY : process.env.GEMINI_API_KEY) ||
        ''
      ).trim();
      if (!apiKey) throw new Error('Clé API manquante pour générer le résumé.');

      const prompt = `Tu es une IA spécialisée dans la compréhension, la synthèse et la mémorisation de livres.

Ta mission est d’analyser le chapitre fourni et de produire un résumé extrêmement utile pour une personne qui écoute le livre sous forme de livre audio.

L’objectif n’est PAS simplement de raccourcir le texte.

Le résumé doit permettre à l’utilisateur :
- de comprendre ce qui s’est passé ou ce qui a été expliqué ;
- de retenir les informations essentielles ;
- de reprendre facilement son écoute plus tard ;
- de comprendre le chapitre suivant sans avoir besoin de réécouter celui-ci.

IMPORTANT — ANTI-SPOILER

Tu dois te baser principalement sur le chapitre fourni.
Tu peux utiliser le contexte des chapitres précédents uniquement pour comprendre les références, personnages, événements ou concepts déjà introduits.
Tu ne dois JAMAIS révéler une information provenant d’un chapitre suivant.
Ne prédis pas la suite de l’histoire.
Ne transforme pas des indices en certitudes.
Si une information n’est pas explicitement présente dans le chapitre, ne l’invente pas.

ADAPTATION AU TYPE DE LIVRE

Commence par identifier silencieusement le type de contenu :
- roman / fiction ;
- biographie ;
- histoire ;
- essai ;
- développement personnel ;
- business ;
- philosophie ;
- sciences ;
- manuel scolaire ;
- livre professionnel ;
- autre contenu documentaire.

Adapte ensuite le résumé au type de livre.
Pour une fiction, privilégie : événements, personnages, décisions, conflits, révélations, évolution des personnages, causes et conséquences.
Pour un livre documentaire, privilégie : idées, concepts, arguments, méthodes, exemples importants, chiffres réellement utiles, conclusions, applications pratiques.
Ne force jamais une catégorie qui n’a pas de sens.

STRUCTURE DE SORTIE STRICTE (utilise exactement ces titres avec ces émojis) :

### ⚡ Le chapitre en 30 secondes
(Résume le chapitre en 3 à 6 phrases maximum. Va directement à l'information importante sans phrase d'introduction générique.)

---

### 📖 Résumé détaillé
(Produis un résumé clair, fluide et structuré de 150 à 400 mots respectant l'ordre logique ou chronologique.)

---

### 🧠 À retenir
(Sélectionne entre 3 et 7 éléments maximum, courts, précis et faciles à mémoriser sous forme de puces tirets.)

---

### 👥 Personnages importants
(Affiche cette section uniquement si des personnages jouent un rôle significatif : **Nom du personnage** — rôle dans le chapitre, action importante ou évolution notable.)

OU (si le livre n'est pas narratif) :

### 💡 Concepts importants
(**Nom du concept** — définition ou rôle expliqué simplement en une ou deux phrases.)

---

### 🔗 Pourquoi ce chapitre est important
(Explique en 2 à 4 phrases le rôle de ce chapitre dans l’ensemble du livre, sans spoiler la suite.)

---

### 🎯 Si tu ne devais retenir qu’une seule chose
(Écris UNE seule phrase forte représentant le cœur ou la leçon essentielle du chapitre.)

---

DONNÉES FOURNIES :
TITRE DU LIVRE : ${bookTitle || 'Livre audio'}
TITRE DU CHAPITRE : ${chapterTitle || 'Chapitre'}
${previousChaptersContext ? `CONTEXTE DES CHAPITRES PRÉCÉDENTS :\n${previousChaptersContext}\n` : ''}
CONTENU DU CHAPITRE :
${chapterText.slice(0, 48000)}`;

      const summary = await generateTextWithProvider(prompt, {
        provider,
        apiKey,
        apiSecret: String(req.headers['x-api-secret'] || ''),
        region: String(req.headers['x-aws-region'] || 'eu-west-3'),
      });
      res.json({ summary, provider });
    } catch (err: any) {
      console.error('Erreur génération résumé IA:', err);
      res.status(500).json({ error: err?.message || 'Erreur lors de la génération du résumé IA.' });
    }
  });

  // List all books stored in cloud
  app.get('/api/cloud/books', (_req: Request, res: Response) => {
    const list = Array.from(jobs.values()).map(job => ({
      id: job.id,
      title: job.title,
      name: job.name,
      size: job.size,
      status: job.status,
      pages: job.pages,
      processingProgress: job.processingProgress,
      audioReady: job.chapters.filter(c => c.hasAudio).length,
      totalChapters: job.chapters.length,
      chapters: job.chapters.map(c => ({
        id: c.id,
        index: c.index,
        title: c.title,
        text: c.text,
        words: c.words,
        estimatedMinutes: c.estimatedMinutes,
        hasAudio: c.hasAudio,
        audioUrl: c.hasAudio ? `/api/cloud/audio/${job.id}/${c.id}` : undefined,
      })),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));
    res.json(list);
  });

  // Direct upload of PDF in base64
  app.post('/api/cloud/upload', async (req: Request, res: Response) => {
    try {
      const { name, title, base64Pdf } = req.body as { name?: string; title?: string; base64Pdf?: string };
      if (!base64Pdf) {
        return res.status(400).json({ error: 'Fichier PDF manquant dans la requête.' });
      }

      const jobId = crypto.randomUUID();
      const pdfBuffer = Buffer.from(base64Pdf, 'base64');
      const job: CloudJob = {
        id: jobId,
        title: title || name?.replace(/\.pdf$/i, '') || 'Livre sans titre',
        name: name || 'livre.pdf',
        size: pdfBuffer.length,
        status: 'processing',
        pages: 1,
        processingProgress: 20,
        audioReady: 0,
        ttsConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.DEEPINFRA_API_KEY || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)),
        ttsProvider: process.env.TTS_PROVIDER || 'multi-provider',
        chapters: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(jobId, job);
      saveJobToDisk(job);

      // Async process in background
      void (async () => {
        try {
          job.processingProgress = 40;
          saveJobToDisk(job);

          const result = await extractBookFromPdf(pdfBuffer, job.name);
          job.title = result.bookTitle || job.title;
          job.chapters = result.chapters.map((ch, idx) => ({
            id: `ch-${idx + 1}`,
            index: idx,
            title: ch.title,
            text: ch.text,
            words: countWords(ch.text),
            estimatedMinutes: Math.max(1, Math.round(countWords(ch.text) / 150)),
            hasAudio: false,
          }));

          job.pages = Math.max(1, job.chapters.length);
          job.status = 'ready';
          job.processingProgress = 100;
          job.updatedAt = Date.now();
          saveJobToDisk(job);
        } catch (err: any) {
          console.error('Extraction error:', err);
          job.status = 'failed';
          job.error = err?.message || 'L’analyse cloud directe du PDF est désactivée ; utilise l’import local LivreVox.';
          job.updatedAt = Date.now();
          saveJobToDisk(job);
        }
      })();

      res.json({ id: jobId, status: 'processing' });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erreur d’envoi cloud' });
    }
  });

  // Chunked upload creation
  app.post('/api/cloud/jobs', (req: Request, res: Response) => {
    const { name, title, size } = req.body as { name?: string; title?: string; size?: number };
    if (!name || !size || size <= 0) {
      return res.status(400).json({ error: 'Fichier PDF invalide.' });
    }

    const chunkSize = 2 * 1024 * 1024;
    const totalParts = Math.ceil(size / chunkSize);
    const jobId = crypto.randomUUID();

    const job: CloudJob = {
      id: jobId,
      title: title || name.replace(/\.pdf$/i, ''),
      name,
      size,
      status: 'uploading',
      pages: 1,
      processingProgress: 0,
      audioReady: 0,
      ttsConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.DEEPINFRA_API_KEY || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)),
      ttsProvider: process.env.TTS_PROVIDER || 'multi-provider',
      chapters: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    jobs.set(jobId, job);
    uploadChunks.set(jobId, { totalParts, parts: new Map() });
    res.json({ id: jobId, chunkSize, totalParts });
  });

  // Chunked upload slice
  app.post('/api/cloud/jobs/:id/chunk', (req: Request, res: Response) => {
    const { id } = req.params;
    const { index, data } = req.body as { index?: number; data?: string };

    const chunkData = uploadChunks.get(id);
    if (!chunkData || typeof index !== 'number' || !data) {
      return res.status(400).json({ error: 'Bloc manquant ou invalide.' });
    }

    const buf = Buffer.from(data, 'base64');
    chunkData.parts.set(index, buf);
    res.json({ ok: true, index });
  });

  // Chunked upload complete
  app.post('/api/cloud/jobs/:id/complete', (req: Request, res: Response) => {
    const { id } = req.params;
    const job = jobs.get(id);
    const chunkData = uploadChunks.get(id);

    if (!job || !chunkData) {
      return res.status(404).json({ error: 'Tâche cloud introuvable.' });
    }

    if (chunkData.parts.size < chunkData.totalParts) {
      return res.status(400).json({ error: 'Tous les blocs du document n’ont pas été reçus.' });
    }

    const sortedBuffers: Buffer[] = [];
    for (let i = 0; i < chunkData.totalParts; i += 1) {
      const part = chunkData.parts.get(i);
      if (!part) return res.status(400).json({ error: `Bloc ${i} manquant.` });
      sortedBuffers.push(part);
    }
    const fullBuffer = Buffer.concat(sortedBuffers);
    uploadChunks.delete(id);

    job.status = 'processing';
    job.processingProgress = 25;
    saveJobToDisk(job);

    void (async () => {
      try {
        job.processingProgress = 45;
        saveJobToDisk(job);

        const result = await extractBookFromPdf(fullBuffer, job.name);
        job.title = result.bookTitle || job.title;
        job.chapters = result.chapters.map((ch, idx) => ({
          id: `ch-${idx + 1}`,
          index: idx,
          title: ch.title,
          text: ch.text,
          words: countWords(ch.text),
          estimatedMinutes: Math.max(1, Math.round(countWords(ch.text) / 150)),
          hasAudio: false,
        }));

        job.pages = Math.max(1, job.chapters.length);
        job.status = 'ready';
        job.processingProgress = 100;
        job.updatedAt = Date.now();
        saveJobToDisk(job);
      } catch (err: any) {
        console.error('Cloud processing error:', err);
        job.status = 'failed';
        job.error = err?.message || 'Erreur lors de l’analyse du PDF.';
        job.updatedAt = Date.now();
        saveJobToDisk(job);
      }
    })();

    res.json({ ok: true, status: 'processing' });
  });

  // Get job details
  app.get('/api/cloud/jobs/:id', (req: Request, res: Response) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Livre cloud introuvable.' });

    // Update hasAudio flags
    for (const ch of job.chapters) {
      const aPath = audioPathFor(job.id, ch.id);
      ch.hasAudio = fs.existsSync(aPath);
      if (ch.hasAudio) ch.audioPath = `/api/cloud/audio/${job.id}/${ch.id}`;
    }
    job.audioReady = job.chapters.filter(c => c.hasAudio).length;

    res.json({
      id: job.id,
      title: job.title,
      name: job.name,
      size: job.size,
      status: job.status,
      pages: job.pages,
      processingProgress: job.processingProgress,
      audioReady: job.audioReady,
      ttsConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.DEEPINFRA_API_KEY || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)),
      ttsProvider: process.env.TTS_PROVIDER || 'multi-provider',
      error: job.error,
      chapters: job.chapters.map(c => ({
        id: c.id,
        index: c.index,
        title: c.title,
        text: c.text,
        words: c.words,
        estimatedMinutes: c.estimatedMinutes,
        hasAudio: c.hasAudio,
        audioUrl: c.hasAudio ? `/api/cloud/audio/${job.id}/${c.id}` : undefined,
      })),
    });
  });

  // Trigger TTS audio generation for a chapter or next pending chapter
  app.post('/api/cloud/jobs/:id/generate-audio', async (req: Request, res: Response) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Livre cloud introuvable.' });

    const { chapterId, voiceName } = req.body as { chapterId?: string; voiceName?: string };
    let targetChapter: CloudChapter | undefined;

    if (chapterId) {
      targetChapter = job.chapters.find(c => c.id === chapterId);
    } else {
      targetChapter = job.chapters.find(c => !c.hasAudio);
    }

    if (!targetChapter) {
      return res.json({ complete: true, message: 'Tous les chapitres audio sont déjà générés.' });
    }

    try {
      job.status = 'generating_audio';
      const customKey =
        (req.headers['x-gemini-api-key'] as string) ||
        (req.body as any)?.apiKey ||
        process.env.GEMINI_API_KEY;
      const audioBuffer = await synthesizeSpeech(targetChapter.text, voiceName || 'Kore', customKey);
      const outFile = audioPathFor(job.id, targetChapter.id);
      fs.writeFileSync(outFile, audioBuffer);

      targetChapter.hasAudio = true;
      targetChapter.audioPath = `/api/cloud/audio/${job.id}/${targetChapter.id}`;
      targetChapter.audioDuration = Math.round(audioBuffer.length / (24000 * 2)); // 24kHz 16-bit mono

      job.audioReady = job.chapters.filter(c => c.hasAudio).length;
      job.status = job.audioReady >= job.chapters.length ? 'complete' : 'ready';
      job.updatedAt = Date.now();
      saveJobToDisk(job);

      res.json({
        ok: true,
        chapterId: targetChapter.id,
        audioUrl: targetChapter.audioPath,
        audioReady: job.audioReady,
        totalChapters: job.chapters.length,
      });
    } catch (err: any) {
      console.error('Audio generation error:', err);
      job.status = 'ready';
      saveJobToDisk(job);
      res.status(500).json({ error: err?.message || 'Erreur lors de la synthèse vocale Gemini Flash.' });
    }
  });

  // Compatibility endpoint for /tts-next
  app.post('/api/cloud/jobs/:id/tts-next', async (req: Request, res: Response) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Livre cloud introuvable.' });

    const pending = job.chapters.find(c => !c.hasAudio);
    if (!pending) {
      job.status = 'complete';
      return res.json({ id: job.id, status: 'complete', audioReady: job.chapters.length });
    }

    try {
      const voice = (req.body as { voice?: string })?.voice || 'Kore';
      const customKey =
        (req.headers['x-gemini-api-key'] as string) ||
        (req.body as any)?.apiKey ||
        process.env.GEMINI_API_KEY;
      const audioBuffer = await synthesizeSpeech(pending.text, voice, customKey);
      const outFile = audioPathFor(job.id, pending.id);
      fs.writeFileSync(outFile, audioBuffer);
      pending.hasAudio = true;
      pending.audioPath = `/api/cloud/audio/${job.id}/${pending.id}`;
      job.audioReady = job.chapters.filter(c => c.hasAudio).length;
      job.status = job.audioReady >= job.chapters.length ? 'complete' : 'ready';
      saveJobToDisk(job);

      res.json({
        id: job.id,
        status: job.status,
        audioReady: job.audioReady,
        chapters: job.chapters.map(c => ({
          ...c,
          audioUrl: c.hasAudio ? `/api/cloud/audio/${job.id}/${c.id}` : undefined,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Synthèse audio cloud impossible.' });
    }
  });

  // Stream WAV audio file with byte-range support
  app.get('/api/cloud/audio/:jobId/:chapterId', (req: Request, res: Response) => {
    const { jobId, chapterId } = req.params;
    const filePath = audioPathFor(jobId, chapterId.replace(/\.wav$/i, ''));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Fichier audio non disponible.' });
    }

    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/wav',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // Export full book ZIP
  app.get('/api/cloud/export/:jobId', (req: Request, res: Response) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Livre introuvable.' });

    const entries: Record<string, Uint8Array> = {};
    for (const ch of job.chapters) {
      const fPath = audioPathFor(job.id, ch.id);
      if (fs.existsSync(fPath)) {
        const num = String(ch.index + 1).padStart(2, '0');
        const safeTitle = ch.title.replace(/[^\w\s-]/gi, '').trim() || `Chapitre_${ch.index + 1}`;
        entries[`${num} - ${safeTitle}.wav`] = new Uint8Array(fs.readFileSync(fPath));
      }
    }

    if (Object.keys(entries).length === 0) {
      return res.status(400).json({ error: 'Aucun chapitre audio n’a encore été généré pour ce livre.' });
    }

    const zipped = zipSync(entries, { level: 0 });
    const buffer = Buffer.from(zipped);

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(job.title)}.zip"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  });

  // Delete book and associated audio
  app.delete('/api/cloud/jobs/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    jobs.delete(id);
    try {
      const fPath = jobPath(id);
      if (fs.existsSync(fPath)) fs.unlinkSync(fPath);
      const audioDir = path.join(STORAGE_DIR, 'audio', id);
      if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('Error deleting job files:', e);
    }
    res.json({ ok: true, deleted: true });
  });

  // Create demo book
  app.post('/api/cloud/demo', (_req: Request, res: Response) => {
    const jobId = 'demo-carnet-bleu';
    const demoJob: CloudJob = {
      id: jobId,
      title: 'Le carnet bleu — Démo Cloud',
      name: 'le-carnet-bleu-demo.pdf',
      size: 45000,
      status: 'ready',
      pages: 3,
      processingProgress: 100,
      audioReady: 0,
      ttsConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.DEEPINFRA_API_KEY || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)),
      ttsProvider: process.env.TTS_PROVIDER || 'multi-provider',
      chapters: [
        {
          id: 'demo-ch-1',
          index: 0,
          title: 'Chapitre 1 — La porte entrouverte',
          text: `Il était un peu plus de sept heures lorsque Noé aperçut la lumière sous la porte de l'atelier. D'habitude, la pièce restait fermée jusqu'au samedi. Ce matin-là, pourtant, quelqu'un avait laissé la clé dans la serrure.

Il poussa doucement. Sur la grande table, un carnet bleu attendait, ouvert à une page couverte d'une écriture minuscule. Au centre, une phrase était entourée trois fois : « Écoute avant de chercher à comprendre. »

Noé sourit. Cela ressemblait exactement au genre d'énigme que son grand-père aimait lui laisser.`,
          words: 92,
          estimatedMinutes: 1,
          hasAudio: false,
        },
        {
          id: 'demo-ch-2',
          index: 1,
          title: 'Chapitre 2 — Une voix dans le casque',
          text: `Dans le tiroir du bureau, il trouva un vieux casque audio relié à un petit lecteur. Une seule piste était disponible. Il appuya sur lecture et reconnut immédiatement la voix calme de son grand-père.

« Si tu entends ceci, c'est que tu as trouvé le carnet. Ne cours pas. Regarde autour de toi. Chaque détail compte davantage que la vitesse. »

Noé se retourna. Sur le mur, les cartes, les photographies et les notes semblaient soudain former un chemin.`,
          words: 85,
          estimatedMinutes: 1,
          hasAudio: false,
        },
        {
          id: 'demo-ch-3',
          index: 2,
          title: 'Chapitre 3 — Le premier indice',
          text: `Derrière une photographie du port, une enveloppe avait été glissée dans le cadre. À l'intérieur se trouvait une petite carte avec trois mots : bibliothèque, horloge, midi.

Cette fois, Noé ne chercha pas à deviner trop vite. Il rangea soigneusement le carnet dans son sac, remit le casque à sa place et sortit de l'atelier.

Le mystère pouvait commencer.`,
          words: 64,
          estimatedMinutes: 1,
          hasAudio: false,
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Check if audio exists
    for (const ch of demoJob.chapters) {
      const aPath = audioPathFor(jobId, ch.id);
      ch.hasAudio = fs.existsSync(aPath);
      if (ch.hasAudio) ch.audioPath = `/api/cloud/audio/${jobId}/${ch.id}`;
    }
    demoJob.audioReady = demoJob.chapters.filter(c => c.hasAudio).length;

    jobs.set(jobId, demoJob);
    saveJobToDisk(demoJob);

    res.json({
      id: demoJob.id,
      title: demoJob.title,
      chapters: demoJob.chapters,
    });
  });

  // Export entire codebase as ZIP file
  app.get('/api/export-project-zip', (_req: Request, res: Response) => {
    try {
      const zipEntries: Record<string, Uint8Array> = {};
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', '.cloud_storage', '.aistudio']);

      function addDirRecursive(currentDir: string, relPath = '') {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignoreDirs.has(entry.name)) continue;
          if (entry.name.endsWith('.zip')) continue;
          const full = path.join(currentDir, entry.name);
          const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            addDirRecursive(full, rel);
          } else if (entry.isFile()) {
            const buf = fs.readFileSync(full);
            zipEntries[rel] = new Uint8Array(buf);
          }
        }
      }

      addDirRecursive(__dirname);
      const zipped = zipSync(zipEntries, { level: 6 });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="livrevox-cloud-source.zip"');
      res.send(Buffer.from(zipped));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erreur création ZIP' });
    }
  });

  // Vite in dev mode or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[Auralis Cloud] Serveur actif sur http://${HOST}:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
