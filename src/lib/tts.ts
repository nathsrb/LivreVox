import { zipSync } from 'fflate';
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
  data: Uint8Array;
};

type RemoteTtsResponse = {
  audio?: string;
  mimeType?: string;
  model?: string;
  error?: string;
};

let remoteCapabilityCache: { value: boolean; expiresAt: number } | null = null;

function parseWav(buffer: ArrayBuffer): WavMeta {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const four = (offset: number) =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
  if (four(0) !== 'RIFF' || four(8) !== 'WAVE')
    throw new Error('Le moteur vocal a renvoyé un audio WAV invalide.');
  let offset = 12;
  let format: Omit<WavMeta, 'data'> | null = null;
  let data: Uint8Array | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = four(offset);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: view.getUint16(payload, true),
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        byteRate: view.getUint32(payload + 8, true),
        blockAlign: view.getUint16(payload + 12, true),
        bitsPerSample: view.getUint16(payload + 14, true),
      };
    }
    if (id === 'data')
      data = bytes.slice(payload, Math.min(payload + size, bytes.length));
    offset = payload + size + (size % 2);
  }
  if (!format || !data) throw new Error('Impossible de décoder le WAV généré.');
  return { ...format, data };
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1)
    view.setUint8(offset + i, text.charCodeAt(i));
}

async function mergeWavBlobs(
  blobs: Blob[]
): Promise<{ blob: Blob; duration: number }> {
  if (!blobs.length) throw new Error('Aucun segment audio généré.');
  const parsed = await Promise.all(
    blobs.map(async blob => parseWav(await blob.arrayBuffer()))
  );
  const first = parsed[0];
  for (const wav of parsed) {
    if (
      wav.sampleRate !== first.sampleRate ||
      wav.channels !== first.channels ||
      wav.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error('Les segments audio n’utilisent pas le même format.');
    }
  }
  const silenceBytes =
    Math.floor((first.byteRate * 0.12) / first.blockAlign) * first.blockAlign;
  const totalAudioBytes =
    parsed.reduce((sum, wav) => sum + wav.data.length, 0) +
    silenceBytes * Math.max(0, parsed.length - 1);
  const output = new ArrayBuffer(44 + totalAudioBytes);
  const view = new DataView(output);
  const bytes = new Uint8Array(output);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + totalAudioBytes, true);
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
  view.setUint32(40, totalAudioBytes, true);
  let cursor = 44;
  parsed.forEach((wav, index) => {
    bytes.set(wav.data, cursor);
    cursor += wav.data.length;
    if (index < parsed.length - 1) cursor += silenceBytes;
  });
  return {
    blob: new Blob([output], { type: 'audio/wav' }),
    duration: totalAudioBytes / first.byteRate,
  };
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
  cloudVoice?: string
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
        'Gemini : erreur 429 (quota ou capacité momentanément insuffisante).' +
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
      payload.error || `La synthèse vocale distante a échoué (${response.status}).`
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
 * Cloud-only audiobook rendering: the app never invokes a local TTS engine.
 */
export async function synthesizeChapter(
  text: string,
  onProgress: (value: number, label: string) => void,
  shouldCancel: () => boolean,
  customApiKey?: string,
  cloudVoice?: string,
  cacheContext?: { bookId: string; chapterId: string }
): Promise<{ blob: Blob; duration: number; engineVoiceId: string }> {
  const stored = getStoredProviderConfig();
  const activeKey = (customApiKey || stored.apiKey || '').trim();
  const provider = stored.provider;
  const available = Boolean(activeKey) || await isRemoteTtsAvailable(false, activeKey);
  if (!available) {
    throw new Error('Le service ' + provider + ' est indisponible sur Netlify. Vérifie sa configuration.');
  }
  if (shouldCancel()) throw new Error('Génération annulée.');
  const providerLabel = provider === 'deepinfra'
    ? 'DeepInfra · Kokoro'
    : provider === 'aws-polly'
      ? 'Amazon Polly'
      : 'Gemini';
  // Each request narrates about 200 words instead of ~80, reducing API calls
  // and quota pressure without using a long, potentially unstable TTS output.
  const remoteChunks = chunkForSpeech(text, 1200);
  const engineVoiceId = `${provider}:${cloudVoice || (provider === 'deepinfra' ? 'ff_siwis' : provider === 'aws-polly' ? 'Lea' : 'Kore')}`;
  const storedSegments = cacheContext
    ? await getSpeechSegments(cacheContext.bookId, cacheContext.chapterId)
    : [];
  const availableSegments = new Map(
    storedSegments.filter(segment => segment.voiceId === engineVoiceId)
      .map(segment => [segment.index, segment])
  );
  const remoteBlobs: Blob[] = [];
  let reused = 0;
  for (let index = 0; index < remoteChunks.length; index += 1) {
    if (shouldCancel()) throw new Error('Génération annulée. Les passages déjà générés sont conservés.');
    const chunk = remoteChunks[index];
    const signature = textFingerprint(chunk);
    const cached = availableSegments.get(index);
    const progress = Math.round(12 + (index / Math.max(1, remoteChunks.length)) * 82);

    if (cached?.textHash === signature && cached.blob?.size > 0 && (provider !== 'deepinfra' || cached.blob.type.includes('wav'))) {
      remoteBlobs.push(cached.blob);
      reused++;
      onProgress(progress, `${providerLabel} · reprise du segment ${index + 1}/${remoteChunks.length} (${reused} sauvegardés)`);
      continue;
    }

    let segmentAudio: Blob | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (shouldCancel()) throw new Error('Génération annulée. Les passages déjà générés sont conservés.');
      onProgress(progress, `${providerLabel} · génération ${index + 1}/${remoteChunks.length}`);
      try {
        segmentAudio = await synthesizeRemoteChunk(chunk, activeKey, cloudVoice);
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const quotaError = /429|RESOURCE_EXHAUSTED|quota/i.test(reason);
        const permanentQuota = /(?:requests? per day|per.?day|daily|quota[^\n]{0,45}0\b)/i.test(reason);
        if (!quotaError || permanentQuota || attempt === 2) {
          if (quotaError) {
            throw new Error(
              `Gemini a refusé le passage ${index + 1}/${remoteChunks.length} (429). ` +
              `Les ${remoteBlobs.length} passages déjà réussis sont conservés dans le navigateur. ` +
              'Relance « Générer ce chapitre » pour les reprendre, sans tout recommencer. ' +
              reason.slice(0, 230)
            );
          }
          throw error;
        }
        const waitMs = attempt === 0 ? 12000 : 30000;
        await sleepWithCancel(waitMs, shouldCancel, seconds => {
          onProgress(progress, `Quota ${providerLabel} (429) · nouvelle tentative dans ${seconds}s · passages conservés`);
        });
      }
    }
    if (!segmentAudio) throw new Error('Aucun audio reçu pour ce passage.');
    if (cacheContext) {
      await saveSpeechSegment({
        id: `${cacheContext.bookId}:${cacheContext.chapterId}:${engineVoiceId}:${index}`,
        bookId: cacheContext.bookId,
        chapterId: cacheContext.chapterId,
        voiceId: engineVoiceId,
        index,
        textHash: signature,
        blob: segmentAudio,
      });
    }
    remoteBlobs.push(segmentAudio);
  }
  onProgress(96, `Assemblage du chapitre audio · ${providerLabel}`);
  if (remoteBlobs.every(blob => blob.type.includes('wav'))) {
    const merged = await mergeWavBlobs(remoteBlobs);
    onProgress(100, `Audio ${providerLabel} prêt`);
    return { ...merged, engineVoiceId };
  }
  const combinedBlob = new Blob(remoteBlobs, {
    type: remoteBlobs[0]?.type || 'audio/mpeg',
  });
  const estimatedDuration = Math.max(1, text.trim().split(/\s+/).length / 150) * 60;
  onProgress(100, `Audio ${providerLabel} prêt`);
  return { blob: combinedBlob, duration: estimatedDuration, engineVoiceId };
}

export async function makeBookZip(
  _title: string,
  items: Array<{ index: number; title: string; blob: Blob }>
): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const item of items) {
    const prefix = String(item.index + 1).padStart(2, '0');
    entries[`${prefix} - ${sanitizeFileName(item.title)}.wav`] = new Uint8Array(
      await item.blob.arrayBuffer()
    );
  }
  const zipped = zipSync(entries, { level: 0 });
  return new Blob(
    [
      zipped.buffer.slice(
        zipped.byteOffset,
        zipped.byteOffset + zipped.byteLength
      ) as ArrayBuffer,
    ],
    { type: 'application/zip' }
  );
}
