/**
 * Auralis / LivreVox — API Netlify.
 * Secrets: set GEMINI_API_KEY or DEEPINFRA_API_KEY (or AWS keys) in Netlify
 * Site configuration → Environment variables, with Functions scope.
 * No secret is injected into the Vite browser bundle.
 */
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';

const env = (key: string): string => {
  const platformValue = (globalThis as any).Netlify?.env?.get?.(key);
  return String(platformValue || process.env[key] || '').trim();
};
const respond = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const header = (request: Request, key: string) => request.headers.get(key)?.trim() || '';

type ProviderName = 'gemini' | 'deepinfra' | 'aws-polly';

type ProviderCredentials = {
  provider: ProviderName;
  apiKey: string;
  apiSecret?: string;
  region?: string;
};

function normalizeProvider(_value?: string): ProviderName {
  // Preview-only build: Kokoro via DeepInfra is the sole permitted generation provider.
  // This also rejects stale Gemini preferences and any client-supplied override.
  return 'deepinfra';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}


async function synthesizeGemini(text: string, voice: string, apiKey: string) {
  const model = env('GEMINI_TTS_MODEL') || 'gemini-3.8-flash-lite-tts';
  const modern = model.startsWith('gemini-3.');
  const endpoint = modern
    ? 'https://generativelanguage.googleapis.com/v1beta/interactions'
    : 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const payload = modern ? {
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: [{ voice: voice || 'Kore' }] },
  } : {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } },
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(50000),
  });
  if (!response.ok) throw new Error('Gemini TTS (' + response.status + '): ' + (await response.text()).slice(0,700));
  const data = await response.json() as any;
  // Interactions API returns the audio directly as output_audio.data.
  // Older shapes may still expose it through a step.
  const block = modern
    ? (data?.output_audio || data?.outputAudio ||
        (data?.steps || []).flatMap((s: any) => s?.type === 'model_output' ? (s?.content || []) : [])
          .filter((c: any) => c?.type === 'audio' && c?.data).at(-1))
    : data?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData;
  if (!block?.data) throw new Error('Le fournisseur Gemini n’a renvoyé aucun audio.');
  let buffer = Buffer.from(block.data, 'base64');
  // Les modèles historiques renvoient parfois du PCM sans en-tête WAV.
  if (buffer.subarray(0,4).toString() !== 'RIFF') {
    const header = Buffer.alloc(44), rate = 24000;
    header.write('RIFF',0); header.writeUInt32LE(36 + buffer.length,4);
    header.write('WAVEfmt ',8); header.writeUInt32LE(16,16);
    header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
    header.writeUInt32LE(rate,24); header.writeUInt32LE(rate*2,28);
    header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
    header.write('data',36); header.writeUInt32LE(buffer.length,40);
    buffer = Buffer.concat([header,buffer]);
  }
  return { buffer, mimeType: 'audio/wav', extension: 'wav' };
}

async function synthesizeDeepInfra(text: string, voice: string, apiKey: string) {
  const response = await fetch('https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      tts_response_format: 'wav',
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
    return { buffer: Buffer.from(await audio.arrayBuffer()), mimeType: 'audio/wav', extension: 'wav' };
  }
  const clean = payload.audio.includes(',') ? payload.audio.slice(payload.audio.indexOf(',') + 1) : payload.audio;
  return { buffer: Buffer.from(clean, 'base64'), mimeType: 'audio/wav', extension: 'wav' };
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
        model: env('DEEPINFRA_TEXT_MODEL') || 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        // Summaries need direct output, not the model's default lengthy reasoning.
        // This prevents reasoning tokens from consuming the output budget and time.
        reasoning_effort: 'none',
        max_tokens: 1800,
        stream: false,
      }),
      signal: AbortSignal.timeout(26000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`DeepInfra résumé (${response.status}): ${detail}`);
    }
    const payload = await response.json() as any;
    const summary = payload?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('DeepInfra a renvoyé un résumé vide.');
    return summary.trim();
  }
  const model = env('GEMINI_TEXT_MODEL') || 'gemini-3.8-flash';
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



type Body = Record<string, any>;
function configured(provider: ProviderName, request: Request, body: Body = {}) {
  const apiKey = String((provider === 'deepinfra' ? env('DEEPINFRA_API_KEY') : '') || body.apiKey || header(request,'x-api-key') || header(request,'x-gemini-api-key') || (
    provider === 'deepinfra' ? env('DEEPINFRA_API_KEY') :
    provider === 'aws-polly' ? env('AWS_ACCESS_KEY_ID') : env('GEMINI_API_KEY')
  )).trim();
  const apiSecret = String(body.apiSecret || header(request,'x-api-secret') || env('AWS_SECRET_ACCESS_KEY')).trim();
  const region = String(body.region || header(request,'x-aws-region') || env('AWS_REGION') || 'eu-west-3').trim();
  return { provider, apiKey, apiSecret, region };
}
const providerFor = (request: Request, body: Body = {}) =>
  normalizeProvider(body.provider || header(request,'x-tts-provider') || env('TTS_PROVIDER'));

function classifyError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Erreur du service IA.';
  const quota = /429|RESOURCE_EXHAUSTED|quota|throttl/i.test(message);
  const authentication = /401|403|API_KEY|permission|unauthorized|forbidden/i.test(message);
  const invalid = /400|INVALID_ARGUMENT|voice|model|malformed/i.test(message);
  const timeout = /timeout|aborted|délai/i.test(message);
  return { error: message, status: quota ? 429 : authentication ? 401 : invalid ? 400 : timeout ? 504 : 502 };
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Netlify uses a custom path, so read /api/* from the original URL.
  // Retain query-based routing for compatibility.
  const route = url.pathname.startsWith('/api/')
    ? url.pathname.slice('/api/'.length)
    : (url.searchParams.get('route') || '');
  const path = '/api/' + route.replace(/^\/+/, '');
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, {status: 204});
  if (path === '/api/health' || path === '/api/cloud/capabilities') {
    const provider = providerFor(request);
    const creds = configured(provider,request);
    const isSet = Boolean(creds.apiKey && (provider !== 'aws-polly' || creds.apiSecret));
    if (path.endsWith('/capabilities')) {
      return respond({ cloud:false, ttsConfigured:isSet, ttsProvider:provider, providers:['gemini','deepinfra','aws-polly'],chunkUpload:false,ocr:false,mode:'netlify' });
    }
    return respond({ ok:true,provider,ttsConfigured:isSet,host:'netlify',ttsModel: 'hexgrad/Kokoro-82M',textProvider: 'deepinfra' });
  }
  if (path === '/api/voices' && method === 'GET') {
    // The preview is Kokoro-only: do not query Gemini's outdated voice catalog.
    return respond({ voices: [{ id: 'ff_siwis', name: 'Siwis', displayName: 'Siwis · Français (Kokoro)', languageCode: 'fr-FR', type: 'prebuilt' }], source: 'deepinfra-kokoro' });
  }
  if (!path.startsWith('/api/') || method !== 'POST') {
    return respond({error:'Route API non disponible sur Netlify.'},404);
  }
  const length = Number(header(request,'content-length') || 0);
  if (length > 140000) return respond({error:'Requête trop volumineuse.'},413);
  let body: Body;
  try { body = await request.json() as Body; } catch { return respond({error:'JSON invalide.'},400); }
  const provider = providerFor(request,body);
  const credentials = configured(provider,request,body);
  if (path === '/api/validate-key') {
    if (!credentials.apiKey) return respond({ok:false,error:'Ajoute la clé dans Netlify → Environment variables, ou saisis-la ici.'},503);
    if (provider === 'aws-polly' && !credentials.apiSecret) return respond({ok:false,error:'AWS_SECRET_ACCESS_KEY manquante.'},503);
    try {
      await synthesizeProviderSpeech('Test de connexion Auralis.',provider==='deepinfra'?'ff_siwis':provider==='aws-polly'?'Lea':'Kore', credentials);
      return respond({ok:true,provider,message:'Connexion fournisseur validée.'});
    } catch (err) { const e=classifyError(err); return respond({ok:false,error:e.error},e.status); }
  }
  if (path === '/api/tts') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return respond({error:'Texte vide.'},400);
    if (text.length > 3500) return respond({error:'Texte trop long pour un segment, découpe en passages.'},413);
    if (!credentials.apiKey) return respond({error:'Clé API manquante : configure-la dans Netlify.'},503);
    try {
      const voice = String(body.voice || (provider==='deepinfra'?'ff_siwis':provider==='aws-polly'?'Lea':'Kore')).slice(0,128);
      const audio = await synthesizeSpeech(text,voice,credentials);
      // Stream as binary rather than base64 JSON (Netlify's buffered 6 MB limit).
      const bytes = audio.buffer;
      if (bytes.byteLength > 19 * 1024 * 1024) return respond({error:'Audio trop volumineux, découpe le texte.'},413);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset=0;offset<bytes.length;offset+=64*1024)
            controller.enqueue(new Uint8Array(bytes.subarray(offset,offset+64*1024)));
          controller.close();
        }
      });
      return new Response(stream,{
        status:200,
        headers:{'Content-Type':audio.mimeType,'Cache-Control':'no-store','X-Auralis-Provider':provider}
      });
    } catch (err) {
      const e=classifyError(err);
      return respond({error:e.error,provider},e.status);
    }
  }
  if (path === '/api/chapters/summary') {
    if (provider === 'aws-polly') return respond({error:'Amazon Polly ne produit pas de résumé. Utilise Gemini ou DeepInfra.'},400);
    if (!credentials.apiKey) return respond({error:'Clé API du fournisseur manquante dans Netlify.'},503);
    const chapterText = typeof body.chapterText === 'string' ? body.chapterText : '';
    const summaryParts: string[] = Array.isArray(body.summaryParts)
      ? body.summaryParts.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 24)
      : [];
    const chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0,250) : '';
    const bookTitle = typeof body.bookTitle === 'string' ? body.bookTitle.slice(0,250) : '';
    const previousChaptersContext = typeof body.previousChaptersContext === 'string' ? body.previousChaptersContext.slice(0,12000) : '';
    if (!chapterText.trim() && !summaryParts.length) return respond({error:'Texte du chapitre requis.'},400);
    try {

      const prompt = `Tu rédiges une fiche de lecture précise, agréable à lire et directement utile.
Lis le texte fourni, identifie si c'est une fiction ou une non-fiction et adapte le contenu.
Ne parle jamais d'IA, de modèle, d'outil, de traitement ou de procédé technique.
Écris en français naturel, clair et concret. Ne répète pas la même idée dans plusieurs sections.

RÈGLES DE FIABILITÉ
- Appuie-toi uniquement sur le chapitre fourni. Le contexte des chapitres précédents sert uniquement à comprendre les références.
- Ne révèle rien des chapitres suivants, ne prédis rien, n'invente ni fait, ni action, ni intention, ni citation.
- Si un conseil est une déduction plutôt qu'une consigne explicite de l'auteur, indique « Piste d'application ».
- Si un objectif ou un plan n'est pas explicité dans la fiction, indique-le et décris seulement les indices et choix effectivement observables.
- N'utilise que les sections suivantes, sans séparateurs ---, sans emojis et sans conclusions redondantes.
- Adapte la longueur à la densité du chapitre, 350 à 650 mots maximum au total.

STRUCTURE COMMUNE :
### L'essentiel en quelques lignes
4 à 6 phrases donnant l'idée ou le mouvement central, sans formule creuse.
### Comprendre le chapitre
Explication structurée des faits ou des idées, avec leurs causes, exemples importants et conséquences. Ne répète pas l'introduction.

POUR UNE NON-FICTION (essai, développement personnel, pratique, histoire, sciences, enseignement, documentaire), AJOUTE :
### Ce qu'il faut retenir
3 à 5 idées distinctes et précises, avec le sens des concepts utiles, sans répéter le résumé détaillé.
### Passer à la pratique
Repère TOUTES les actions, méthodes, exercices, habitudes, stratégies ou décisions réellement proposées dans ce chapitre et qui aident à atteindre son objectif. Présente-les dans un ordre concret et logique, sous forme de liste numérotée, avec « quoi faire », « comment » et « dans quel but » lorsque le texte permet de le préciser. Inclus les conditions, étapes, indicateurs et obstacles si le chapitre en parle. Si aucune méthode n'est donnée, indique « Aucune action précise n'est proposée dans ce chapitre » et ajoute au maximum deux pistes d'application clairement distinguées des conseils de l'auteur.

POUR UNE FICTION (roman, nouvelle, récit narratif), AJOUTE :
### Les personnages et leur stratégie
Pour chaque personnage important, précise son objectif du moment, son plan ou intention quand il est explicite, les actions et décisions prises, les obstacles rencontrés, leurs conséquences et ce qui reste incertain. Distingue toujours faits, suppositions des personnages et interprétations. S'il n'y a pas de stratégie définie, dis-le.
### Les tournants de l'histoire
Décris les événements qui modifient les enjeux, les relations ou la situation. Pas de prédictions ni de spoilers.

Garde exactement les titres ### indiqués pour le type de livre retenu. Utilise des listes courtes et lisibles lorsque nécessaire, sans ajouter d'autres rubriques.

LIVRE : ${bookTitle || 'Livre'}
CHAPITRE : ${chapterTitle || 'Chapitre'}
${previousChaptersContext ? `CHAPITRES PRÉCÉDENTS :\n${previousChaptersContext}\n` : ''}
SOURCE À ANALYSER :
${summaryParts.length ? 'Ces notes couvrent toutes les parties du chapitre dans l’ordre. Fusionne-les sans répétitions, conserve toutes les actions distinctes et n’ajoute rien d’extérieur.\n' + summaryParts.map((part, index) => 'PARTIE ' + (index + 1) + '\n' + part).join('\n\n') : chapterText.slice(0, 14000)}`;

      const summary = await generateTextWithProvider(prompt, credentials);
      return respond({summary,provider});
    } catch(err) { const e=classifyError(err); return respond({error:e.error},e.status); }
  }
  return respond({error:'Route API non migrée.'},404);
}
export const config = {
  // Serve the original /api/* URL directly instead of a rewrite that lost its route.
  path: '/api/*',
  rateLimit: { action:'rate_limit', aggregateBy:['ip'],windowSize:60,windowLimit:90 }
};
