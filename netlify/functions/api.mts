/**
 * Auralis / LivreVox — API Netlify.
 * Secrets: set GEMINI_API_KEY or DEEPINFRA_API_KEY (or AWS keys) in Netlify
 * Site configuration → Environment variables, with Functions scope.
 * No secret is injected into the Vite browser bundle.
 */
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';

const env = (key: string): string => process.env[key]?.trim() || '';
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
  const block = modern
    ? (data?.steps || []).flatMap((s: any) => s?.type === 'model_output' ? (s?.content || []) : []).filter((c: any) => c?.type === 'audio' && c?.data).at(-1)
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
        model: env('DEEPINFRA_TEXT_MODEL') || 'meta-llama/Llama-3.3-70B-Instruct',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!response.ok) throw new Error(`DeepInfra texte ${response.status}: ${await response.text()}`);
    const payload = await response.json() as any;
    return payload?.choices?.[0]?.message?.content || '';
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



const voicesFeatured =  [
    ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'],
    ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
    ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'],
    ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
    ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
    ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
    ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'],
    ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
    ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'],
    ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
  ].map(([id, description]) => ({
    id,
    name: id,
    displayName: id,
    description,
    type: 'prebuilt',
  }));

type Body = Record<string, any>;
function configured(provider: ProviderName, request: Request, body: Body = {}) {
  const apiKey = String(body.apiKey || header(request,'x-api-key') || header(request,'x-gemini-api-key') || (
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
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, {status: 204});
  if (path === '/api/health' || path === '/api/cloud/capabilities') {
    const provider = providerFor(request);
    const creds = configured(provider,request);
    const isSet = Boolean(creds.apiKey && (provider !== 'aws-polly' || creds.apiSecret));
    if (path.endsWith('/capabilities')) {
      return respond({ cloud:false, ttsConfigured:isSet, ttsProvider:provider, providers:['gemini','deepinfra','aws-polly'],chunkUpload:false,ocr:false,mode:'netlify' });
    }
    return respond({ ok:true,provider:isSet ? provider : 'local-fallback',ttsConfigured:isSet,host:'netlify' });
  }
  if (path === '/api/voices' && method === 'GET') {
    const apiKey = header(request,'x-api-key') || header(request,'x-gemini-api-key') || env('GEMINI_API_KEY');
    if (!apiKey) return respond({voices:voicesFeatured,source:'featured'});
    try {
      const remote = await fetch('https://generativelanguage.googleapis.com/v1beta/voices?page_size=1000',{
        headers: {'x-goog-api-key':apiKey,Accept:'application/json'},
        signal: AbortSignal.timeout(10000),
      });
      if (!remote.ok) throw new Error('Bibliothèque de voix distante indisponible.');
      const data = await remote.json() as any;
      const map = new Map<string,any>(voicesFeatured.map((v:any)=>[v.id,v]));
      for(const v of data?.voices || []) {
        const id = String(v?.id || v?.voiceId || v?.name || '').trim();
        if (id) map.set(id,{id,name:id,displayName:v.displayName || id,description:v.description,languageCode:v.languageCode,accent:v.accent,gender:v.gender,type:v.type});
      }
      return respond({voices:[...map.values()],source:'gemini-library'});
    } catch { return respond({voices:voicesFeatured,source:'featured-fallback'}); }
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
    const chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0,250) : '';
    const bookTitle = typeof body.bookTitle === 'string' ? body.bookTitle.slice(0,250) : '';
    const previousChaptersContext = typeof body.previousChaptersContext === 'string' ? body.previousChaptersContext.slice(0,12000) : '';
    if (!chapterText.trim()) return respond({error:'Texte du chapitre requis.'},400);
    try {

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

      const summary = await generateTextWithProvider(prompt, credentials);
      return respond({summary,provider});
    } catch(err) { const e=classifyError(err); return respond({error:e.error},e.status); }
  }
  return respond({error:'Route API non migrée.'},404);
}
export const config = {
  path: '/api/*',
  rateLimit: { action:'rate_limit', aggregateBy:['ip'],windowSize:60,windowLimit:90 }
};
