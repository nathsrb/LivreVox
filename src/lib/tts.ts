import { Zip, ZipPassThrough } from 'fflate';
import { chunkForSpeech, sanitizeFileName } from './text';
import { getStoredProviderConfig } from './cloud';
import { getSpeechSegments, saveSpeechSegment } from './storage';

export type GeminiVoiceOption = {
  id: string;
  label: string;
  displayName: string;
  description?: string;
  languageCode?: string;
  accent?: string;
  gender?: string;
  type?: string;
};

type WavMeta = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  audioFormat: number;
  dataOffset: number;
  dataSize: number;
};

type RemoteTtsResponse = {
  audio?: string;
  mimeType?: string;
  model?: string;
  error?: string;
};

let remoteCapabilityCache: { value: boolean; expiresAt: number } | null = null;

export type SpeechRoute = 'openai' | 'inference';
let preferredSpeechRoute: SpeechRoute = 'openai';
export function setPreferredSpeechRoute(route: SpeechRoute): void {
  preferredSpeechRoute = route;
}
export function getPreferredSpeechRoute(): SpeechRoute {
  return preferredSpeechRoute;
}


// Read only small WAV headers: never materialize a multi-hour audio file in RAM.
async function parseWav(blob: Blob): Promise<WavMeta> {
  const header = await blob.slice(0, Math.min(65536, blob.size)).arrayBuffer();
  const view = new DataView(header);
  const bytes = new Uint8Array(header);
  const four = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.length < 44 || four(0) !== 'RIFF' || four(8) !== 'WAVE')
    throw new Error('Le passage audio reçu est invalide.');
  let offset = 12;
  let format: Omit<WavMeta, 'dataOffset' | 'dataSize'> | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = four(offset);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (id === 'fmt ' && size >= 16 && payload + 16 <= bytes.length) {
      format = {
        audioFormat: view.getUint16(payload, true),
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        byteRate: view.getUint32(payload + 8, true),
        blockAlign: view.getUint16(payload + 12, true),
        bitsPerSample: view.getUint16(payload + 14, true),
      };
    }
    if (id === 'data') {
      dataOffset = payload;
      dataSize = Math.min(size === 0xffffffff ? blob.size - payload : size, blob.size - payload);
      break;
    }
    const next = payload + size + (size % 2);
    if (next <= offset) break;
    offset = next;
  }
  if (!format || dataOffset < 0 || dataSize <= 0) throw new Error('Audio WAV incomplet.');
  return { ...format, dataOffset, dataSize };
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

async function mergeWavBlobs(blobs: Blob[]): Promise<{ blob: Blob; duration: number }> {
  if (!blobs.length) throw new Error('Aucun passage audio disponible.');
  const parsed = await Promise.all(blobs.map(parseWav));
  const first = parsed[0];
  if (!first.byteRate || !first.blockAlign) throw new Error('Format audio non pris en charge.');
  for (const wav of parsed) {
    if (wav.sampleRate !== first.sampleRate || wav.channels !== first.channels ||
        wav.bitsPerSample !== first.bitsPerSample || wav.audioFormat !== first.audioFormat) {
      throw new Error('Les passages audio n’utilisent pas le même format.');
    }
  }
  const silenceBytes = Math.floor((first.byteRate * 0.10) / first.blockAlign) * first.blockAlign;
  const dataBytes = parsed.reduce((sum, wav) => sum + wav.dataSize, 0) + silenceBytes * Math.max(0, blobs.length - 1);
  // WAV uses 32-bit RIFF sizes. Keep a clear guard instead of overflowing the header.
  if (dataBytes > 0xffffffff - 44)
    throw new Error('Ce chapitre dépasse la capacité d’un seul fichier audio. Il doit être enregistré en plusieurs parties.');
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, first.audioFormat, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.byteRate, true);
  view.setUint16(32, first.blockAlign, true);
  view.setUint16(34, first.bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  const pieces: BlobPart[] = [header];
  const silence = silenceBytes ? new Blob([new Uint8Array(silenceBytes)]) : null;
  blobs.forEach((part, index) => {
    const wav = parsed[index];
    pieces.push(part.slice(wav.dataOffset, wav.dataOffset + wav.dataSize));
    if (index < blobs.length - 1 && silence) pieces.push(silence);
  });
  return { blob: new Blob(pieces, { type: 'audio/wav' }), duration: dataBytes / first.byteRate };
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export async function isRemoteTtsAvailable(
  force = false,
  customApiKey?: string
): Promise<boolean> {
  const stored = getStoredProviderConfig();
  const activeKey = (customApiKey || stored.apiKey || '').trim();
  if (!force && !activeKey && remoteCapabilityCache && remoteCapabilityCache.expiresAt > Date.now())
    return remoteCapabilityCache.value;
  try {
    const response = await fetch('/api/health', {
      headers: {
        Accept: 'application/json',
        'x-tts-provider': stored.provider || 'gemini',
        ...(activeKey ? { 'x-api-key': activeKey } : {}),
      },
    });
    if (!response.ok) throw new Error('API indisponible');
    const payload = (await response.json()) as { ttsConfigured?: boolean };
    const value = Boolean(payload.ttsConfigured);
    remoteCapabilityCache = { value, expiresAt: Date.now() + 15_000 };
    return value;
  } catch {
    remoteCapabilityCache = { value: false, expiresAt: Date.now() + 5_000 };
    return false;
  }
}

export const CLOUD_VOICES: GeminiVoiceOption[] = [
  { id: 'Zephyr', label: 'Zephyr · Bright', displayName: 'Zephyr', description: 'Bright' },
  { id: 'Puck', label: 'Puck · Upbeat', displayName: 'Puck', description: 'Upbeat' },
  { id: 'Charon', label: 'Charon · Informative', displayName: 'Charon', description: 'Informative' },
  { id: 'Kore', label: 'Kore · Firm', displayName: 'Kore', description: 'Firm' },
  { id: 'Fenrir', label: 'Fenrir · Excitable', displayName: 'Fenrir', description: 'Excitable' },
  { id: 'Leda', label: 'Leda · Youthful', displayName: 'Leda', description: 'Youthful' },
  { id: 'Orus', label: 'Orus · Firm', displayName: 'Orus', description: 'Firm' },
  { id: 'Aoede', label: 'Aoede · Breezy', displayName: 'Aoede', description: 'Breezy' },
  { id: 'Callirrhoe', label: 'Callirrhoe · Easy-going', displayName: 'Callirrhoe', description: 'Easy-going' },
  { id: 'Autonoe', label: 'Autonoe · Bright', displayName: 'Autonoe', description: 'Bright' },
  { id: 'Enceladus', label: 'Enceladus · Breathy', displayName: 'Enceladus', description: 'Breathy' },
  { id: 'Iapetus', label: 'Iapetus · Clear', displayName: 'Iapetus', description: 'Clear' },
  { id: 'Umbriel', label: 'Umbriel · Easy-going', displayName: 'Umbriel', description: 'Easy-going' },
  { id: 'Algieba', label: 'Algieba · Smooth', displayName: 'Algieba', description: 'Smooth' },
  { id: 'Despina', label: 'Despina · Smooth', displayName: 'Despina', description: 'Smooth' },
  { id: 'Erinome', label: 'Erinome · Clear', displayName: 'Erinome', description: 'Clear' },
  { id: 'Algenib', label: 'Algenib · Gravelly', displayName: 'Algenib', description: 'Gravelly' },
  { id: 'Rasalgethi', label: 'Rasalgethi · Informative', displayName: 'Rasalgethi', description: 'Informative' },
  { id: 'Laomedeia', label: 'Laomedeia · Upbeat', displayName: 'Laomedeia', description: 'Upbeat' },
  { id: 'Achernar', label: 'Achernar · Soft', displayName: 'Achernar', description: 'Soft' },
  { id: 'Alnilam', label: 'Alnilam · Firm', displayName: 'Alnilam', description: 'Firm' },
  { id: 'Schedar', label: 'Schedar · Even', displayName: 'Schedar', description: 'Even' },
  { id: 'Gacrux', label: 'Gacrux · Mature', displayName: 'Gacrux', description: 'Mature' },
  { id: 'Pulcherrima', label: 'Pulcherrima · Forward', displayName: 'Pulcherrima', description: 'Forward' },
  { id: 'Achird', label: 'Achird · Friendly', displayName: 'Achird', description: 'Friendly' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi · Casual', displayName: 'Zubenelgenubi', description: 'Casual' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix · Gentle', displayName: 'Vindemiatrix', description: 'Gentle' },
  { id: 'Sadachbia', label: 'Sadachbia · Lively', displayName: 'Sadachbia', description: 'Lively' },
  { id: 'Sadaltager', label: 'Sadaltager · Knowledgeable', displayName: 'Sadaltager', description: 'Knowledgeable' },
  { id: 'Sulafat', label: 'Sulafat · Warm', displayName: 'Sulafat', description: 'Warm' },
];

export async function getGeminiVoices(customApiKey?: string): Promise<GeminiVoiceOption[]> {
  const stored = getStoredProviderConfig();
  const activeKey = (customApiKey || stored.apiKey || '').trim();
  try {
    const response = await fetch('/api/voices', {
      headers: {
        Accept: 'application/json',
        'x-tts-provider': 'gemini',
        ...(activeKey ? { 'x-api-key': activeKey } : {}),
      },
    });
    if (!response.ok) return CLOUD_VOICES;
    const payload = (await response.json()) as { voices?: Array<Partial<GeminiVoiceOption> & { id?: string; name?: string }> };
    const voices = (payload.voices || [])
      .map(voice => {
        const id = String(voice.id || voice.name || '').trim();
        if (!id) return null;
        const displayName = String(voice.displayName || id);
        const description = voice.description ? String(voice.description) : undefined;
        return {
          id,
          displayName,
          description,
          label: description ? `${displayName} · ${description}` : displayName,
          languageCode: voice.languageCode,
          accent: voice.accent,
          gender: voice.gender,
          type: voice.type,
        } as GeminiVoiceOption;
      })
      .filter((voice): voice is GeminiVoiceOption => Boolean(voice));
    if (!voices.length) return CLOUD_VOICES;
    const merged = new Map<string, GeminiVoiceOption>();
    CLOUD_VOICES.forEach(voice => merged.set(voice.id, voice));
    voices.forEach(voice => merged.set(voice.id, voice));
    return Array.from(merged.values());
  } catch {
    return CLOUD_VOICES;
  }
}

async function synthesizeRemoteChunk(
  text: string,
  customApiKey?: string,
  cloudVoice?: string,
  route: SpeechRoute = preferredSpeechRoute
): Promise<Blob> {
  const stored = getStoredProviderConfig();
  const activeKey = (customApiKey || stored.apiKey || '').trim();
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/wav, audio/mpeg, application/json',
      'x-tts-provider': stored.provider,
      ...(activeKey ? { 'x-api-key': activeKey } : {}),
      ...(stored.apiSecret ? { 'x-api-secret': stored.apiSecret } : {}),
      ...(stored.region ? { 'x-aws-region': stored.region } : {}),
    },
    body: JSON.stringify({
      text,
      provider: stored.provider,
      ttsRoute: route,
      apiKey: activeKey || undefined,
      apiSecret: stored.apiSecret,
      region: stored.region,
      voice: cloudVoice || (stored.provider === 'deepinfra' ? 'ff_siwis' : stored.provider === 'aws-polly' ? 'Lea' : 'Kore'),
    }),
  });
  // Netlify renvoie un flux audio binaire : pas de base64 JSON ni de limite de 6 Mo.
  // La branche JSON est conservée pour la compatibilité avec l'ancien serveur.
  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.toLowerCase().startsWith('audio/')) {
    return response.blob();
  }
  let payload: RemoteTtsResponse = {};
  try {
    payload = (await response.json()) as RemoteTtsResponse;
  } catch {
    // Le message HTTP ci-dessous reste suffisamment explicite.
  }
  if (!response.ok || !payload.audio) {
    if (response.status === 429) {
      const detail = (payload.error || '').slice(0, 320).replace(/\s+/g, ' ');
      throw new Error(
        'Le service de lecture est momentanément sollicité (429).' +
        (detail ? ' Détail : ' + detail : '')
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Accès à la prévisualisation Netlify refusé (HTTP ' + response.status +
        '). Recharge la page. Si le problème persiste, vérifie la protection d’accès Netlify.'
      );
    }
    throw new Error(
      'Audio (' + response.status + ') : ' + (payload.error || 'Le passage n’a pas pu être préparé.')
    );
  }
  return base64ToBlob(payload.audio, payload.mimeType || 'audio/wav');
}

function textFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return value.length.toString(36) + '-' + (hash >>> 0).toString(36);
}

async function sleepWithCancel(
  milliseconds: number,
  shouldCancel: () => boolean,
  onTick: (remaining: number) => void
): Promise<void> {
  let remaining = milliseconds;
  while (remaining > 0) {
    if (shouldCancel()) throw new Error('Génération annulée. Les passages déjà enregistrés sont conservés.');
    onTick(Math.ceil(remaining / 1000));
    const duration = Math.min(1000, remaining);
    await new Promise<void>(resolve => setTimeout(resolve, duration));
    remaining -= duration;
  }
}

/**
 * Handle short-lived voice-service failures and split slow passages automatically.
 * A successful original passage is then cached in IndexedDB by its stable text hash.
 */
async function synthesizeResilientChunk(
  text: string,
  apiKey: string,
  voice: string | undefined,
  shouldCancel: () => boolean,
  onWait: (seconds: number) => void
): Promise<Blob> {
  let lastError: unknown;
  let canSplit = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (shouldCancel()) throw new Error('Génération interrompue. Les passages terminés sont conservés.');
    try {
      // A timeout on one DeepInfra API surface does not prove Kokoro cannot
      // run on the other. Switch routes on the first retry; keep the cache
      // keyed to the same voice so already rendered chunks remain reusable.
      const route: SpeechRoute = attempt === 1
        ? (preferredSpeechRoute === 'openai' ? 'inference' : 'openai')
        : preferredSpeechRoute;
      const audio = await synthesizeRemoteChunk(text, apiKey, voice, route);
      if (!audio.size) throw new Error('Le service n’a renvoyé aucun son.');
      setPreferredSpeechRoute(route);
      return audio;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const blocked = /\b(400|401|403|413)\b|invalid|unauthori[sz]ed|forbidden/i.test(reason);
      const dailyQuota = /daily|per.day|requests per day|quota[^\n]{0,40}0\b/i.test(reason);
      const rateLimit = /\b429\b|quota|rate.limit/i.test(reason);
      const slow = /\b(502|503|504|520|522|524)\b|timeout|aborted|timed.out/i.test(reason);
      const transient = slow || rateLimit || /network|failed to fetch|fetch failed|temporarily|connection/i.test(reason);
      lastError = error;
      // Only permanent client errors should abort immediately. A 400/404
      // restricted to one TTS API surface may succeed on the other.
      if (dailyQuota || !transient && !/\b(400|404)\b/.test(reason)) throw error;
      if (blocked && !/\b(400|404)\b/.test(reason)) throw error;
      // Try the alternative DeepInfra route before splitting otherwise-valid
      // text. A 504 on /openai/audio/speech alone is not proof that the
      // inference endpoint cannot serve this chunk.
      if (slow && text.length > 420 && attempt >= 1) {
        canSplit = true;
        break;
      }
      if (attempt < 2) {
        const wait = rateLimit ? (attempt === 0 ? 4000 : 9000) : (attempt === 0 ? 1700 : 4300);
        await sleepWithCancel(wait, shouldCancel, onWait);
      }
    }
  }

  if (canSplit && text.length > 420) {
    const middle = Math.floor(text.length / 2);
    const space = text.lastIndexOf(' ', middle);
    const cut = space > text.length / 4 ? space : middle;
    const halves = [text.slice(0, cut).trim(), text.slice(cut).trim()].filter(Boolean);
    if (halves.length === 2) {
      const first = await synthesizeResilientChunk(halves[0], apiKey, voice, shouldCancel, onWait);
      const second = await synthesizeResilientChunk(halves[1], apiKey, voice, shouldCancel, onWait);
      if (first.type.includes('wav') && second.type.includes('wav')) {
        return (await mergeWavBlobs([first, second])).blob;
      }
      return new Blob([first, second], { type: first.type || second.type });
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '';
  throw new Error('Ce passage n’a pas pu être préparé. Les passages précédents sont sauvegardés : relance le chapitre pour reprendre.' +
    (detail && /429/.test(detail) ? ' Le service est momentanément très sollicité.' : ''));
}

/** Generate all passages without a fixed chapter-length timeout. */
export async function synthesizeChapter(
  text: string,
  onProgress: (value: number, label: string) => void,
  shouldCancel: () => boolean,
  customApiKey?: string,
  cloudVoice?: string,
  cacheContext?: { bookId: string; chapterId: string }
): Promise<{ blob: Blob; duration: number; engineVoiceId: string; parts?: Blob[]; partDurations?: number[]; cacheSaveFailed?: boolean }> {
  const stored = getStoredProviderConfig();
  const activeKey = (customApiKey || stored.apiKey || '').trim();
  const provider = stored.provider;
  const available = Boolean(activeKey) || await isRemoteTtsAvailable(false, activeKey);
  if (!available) throw new Error('La création audio est momentanément indisponible.');
  if (!text.trim()) throw new Error('Ce chapitre ne contient pas de texte à lire.');
  if (shouldCancel()) throw new Error('Génération interrompue.');
  // Balance service latency with request count. Cap concurrency at two to
  // avoid flooding the provider or Netlify while halving wall-clock latency.
  // Avoid long Kokoro inference calls that time out behind Netlify's gateway.
  // Keep recognizing previous 720/480/1200-char divisions so older recorded
  // passages are never discarded on an existing chapter.
  // Real DeepInfra integration smoke: 6/6 Kokoro WAVs of ~710 characters
  // succeeded concurrently. Default to 720 chars: about half as many HTTP
  // calls as the previous 360-char preview, while keeping old cache layouts.
  const fastChunks = chunkForSpeech(text, provider === 'deepinfra' ? 720 : 900);
  const previousTinyChunks = chunkForSpeech(text, 360);
  const previousSmallChunks = chunkForSpeech(text, 480);
  const legacyChunks = chunkForSpeech(text, 1200);
  const engineVoiceId = provider + ':' +
    (cloudVoice || (provider === 'deepinfra' ? 'ff_siwis' : provider === 'aws-polly' ? 'Lea' : 'Kore'));
  const storedSegments = cacheContext
    ? await getSpeechSegments(cacheContext.bookId, cacheContext.chapterId)
    : [];
  const availableSegments = new Map(
    storedSegments.filter(segment => segment.voiceId === engineVoiceId)
      .map(segment => [segment.index, segment])
  );
  const hasMatches = (segments: string[]) => segments.some((passage, index) =>
    availableSegments.get(index)?.textHash === textFingerprint(passage));
  // Keep the original division for a chapter already in progress: never throw
  // away successful passages when upgrading from a previous preview.
  const chunks = hasMatches(previousTinyChunks) ? previousTinyChunks :
    hasMatches(previousSmallChunks) ? previousSmallChunks :
    hasMatches(legacyChunks) ? legacyChunks : fastChunks;
  const generated: Blob[] = new Array(chunks.length);
  let completed = 0;
  let reused = 0;
  let failed: unknown = null;
  let cacheSaveFailed = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < chunks.length && !failed) {
      if (shouldCancel()) throw new Error('Génération interrompue. Les passages déjà créés sont conservés.');
      const index = cursor++;
      const passage = chunks[index];
      const signature = textFingerprint(passage);
      const cached = availableSegments.get(index);
      const emitProgress = (label: string) => {
        const progress = Math.round(5 + (completed / Math.max(1, chunks.length)) * 90);
        onProgress(progress, label);
      };
      try {
        let audio: Blob;
        if (cached?.textHash === signature && cached.blob?.size > 0 &&
            (provider !== 'deepinfra' || cached.blob.type.includes('wav'))) {
          audio = cached.blob;
          reused++;
        } else {
          emitProgress('Création de l’audio · ' + completed + '/' + chunks.length + ' passages terminés');
          audio = await synthesizeResilientChunk(
            passage, activeKey, cloudVoice, shouldCancel,
            seconds => emitProgress('Nouvelle tentative dans ' + seconds + ' s · passages conservés')
          );
          if (cacheContext && !cacheSaveFailed) {
            try {
              await saveSpeechSegment({
                id: cacheContext.bookId + ':' + cacheContext.chapterId + ':' + engineVoiceId + ':' + index,
                bookId: cacheContext.bookId,
                chapterId: cacheContext.chapterId,
                voiceId: engineVoiceId,
                index,
                textHash: signature,
                blob: audio,
              });
            } catch (error) {
              // Safari may reject IndexedDB writes even when the phone has
              // free space. The audio is already present as a Blob in memory:
              // keep generating rather than discard paid TTS work.
              cacheSaveFailed = true;
              console.warn('Auralis: speech cache write failed; continuing in memory', error);
              emitProgress('Stockage local indisponible · création de l’audio poursuivie');
            }
          }
        }
        generated[index] = audio;
        completed++;
        emitProgress('Audio · ' + completed + '/' + chunks.length + ' passages prêts' +
          (reused ? ' (' + reused + ' récupérés)' : ''));
      } catch (error) {
        failed = error;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(2, chunks.length) }, () => worker());
  const workerResults = await Promise.allSettled(workers);
  const unsuccessful = workerResults.find(result => result.status === 'rejected');
  if (unsuccessful?.status === 'rejected') throw unsuccessful.reason;
  onProgress(96, 'Assemblage du chapitre · les passages sont conservés');
  // A very long chapter is kept as sequential WAV parts. No single RIFF WAV
  // ever needs to exceed its 32-bit size limit or occupy one enormous buffer.
  if (generated.every(blob => blob.type.includes('wav'))) {
    const maxPartBytes = 80 * 1024 * 1024;
    const groups: Blob[][] = [];
    let pending: Blob[] = [];
    let pendingBytes = 0;
    for (const blob of generated) {
      if (pending.length && pendingBytes + blob.size > maxPartBytes) {
        groups.push(pending);
        pending = [];
        pendingBytes = 0;
      }
      pending.push(blob);
      pendingBytes += blob.size;
    }
    if (pending.length) groups.push(pending);
    const rendered: Array<{ blob: Blob; duration: number }> = [];
    for (let index = 0; index < groups.length; index++) {
      if (shouldCancel()) throw new Error('Génération interrompue. Les passages enregistrés sont conservés.');
      onProgress(96 + Math.round((index / groups.length) * 3), 'Assemblage audio · partie ' + (index + 1) + '/' + groups.length);
      rendered.push(await mergeWavBlobs(groups[index]));
    }
    const duration = rendered.reduce((total, part) => total + part.duration, 0);
    onProgress(100, 'Chapitre audio prêt');
    return {
      blob: rendered[0].blob,
      duration,
      engineVoiceId,
      cacheSaveFailed,
      ...(rendered.length > 1 ? {
        parts: rendered.map(part => part.blob),
        partDurations: rendered.map(part => part.duration),
      } : {}),
    };
  }
  const combinedBlob = new Blob(generated, { type: generated[0]?.type || 'audio/mpeg' });
  const duration = Math.max(1, text.trim().split(/\s+/).length / 150) * 60;
  onProgress(100, 'Chapitre audio prêt');
  return { blob: combinedBlob, duration, engineVoiceId, cacheSaveFailed };
}

/** Build a ZIP incrementally so exporting does not require a huge JS ArrayBuffer. */
export async function makeBookZip(
  _title: string,
  items: Array<{ index: number; title: string; blob: Blob; parts?: Blob[] }>
): Promise<Blob> {
  const chunks: BlobPart[] = [];
  let complete!: () => void;
  let fail!: (reason: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const zip = new Zip((error, data, final) => {
    if (error) { fail(error); return; }
    if (data.length) {
      // Keep browser BlobPart typing valid without retaining a pooled backing buffer.
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(data);
      chunks.push(copy);
    }
    if (final) complete();
  });
  try {
    for (const item of items) {
      const prefix = String(item.index + 1).padStart(2, '0');
      const parts = item.parts?.length ? item.parts : [item.blob];
      for (let index = 0; index < parts.length; index++) {
        const suffix = parts.length > 1 ? ' - Partie ' + String(index + 1).padStart(2, '0') : '';
        const name = prefix + ' - ' + sanitizeFileName(item.title) + suffix + '.wav';
        const file = new ZipPassThrough(name);
        zip.add(file);
        const part = parts[index];
        const blockSize = 256 * 1024;
        for (let offset = 0; offset < part.size; offset += blockSize) {
          const data = new Uint8Array(await part.slice(offset, offset + blockSize).arrayBuffer());
          file.push(data, offset + blockSize >= part.size);
        }
        if (!part.size) file.push(new Uint8Array(0), true);
      }
    }
    zip.end();
    await finished;
    return new Blob(chunks, { type: 'application/zip' });
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
