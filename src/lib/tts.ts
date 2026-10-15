import { zipSync } from 'fflate';
import { chunkForSpeech, sanitizeFileName } from './text';
import { getStoredProviderConfig } from './cloud';

export type VoiceCatalogItem = {
  id: string;
  label: string;
  language: string;
};

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
      Accept: 'application/json',
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
  let payload: RemoteTtsResponse = {};
  try {
    payload = (await response.json()) as RemoteTtsResponse;
  } catch {
    // Le message HTTP ci-dessous reste suffisamment explicite.
  }
  if (!response.ok || !payload.audio) {
    throw new Error(
      payload.error || `La synthèse vocale distante a échoué (${response.status}).`
    );
  }
  return base64ToBlob(payload.audio, payload.mimeType || 'audio/wav');
}

export async function getVoiceCatalog(): Promise<VoiceCatalogItem[]> {
  const piper = await import('@mintplex-labs/piper-tts-web');
  const raw = await piper.voices();
  return Object.keys(raw)
    .filter(id => /^(fr_|en_|es_)/i.test(id))
    .sort((a, b) => a.localeCompare(b))
    .map(id => {
      const language = id.startsWith('fr_')
        ? 'Français'
        : id.startsWith('es_')
          ? 'Espagnol'
          : 'Anglais';
      const label = id.replace(/_/g, ' ').replace(/-/g, ' · ');
      return { id, label, language };
    });
}

export async function getStoredVoices(): Promise<string[]> {
  try {
    const piper = await import('@mintplex-labs/piper-tts-web');
    return await piper.stored();
  } catch {
    return [];
  }
}

export async function downloadVoice(
  voiceId: string,
  onProgress: (value: number) => void
): Promise<void> {
  const piper = await import('@mintplex-labs/piper-tts-web');
  await piper.download(voiceId, progress => {
    if (progress.loaded !== undefined && progress.total)
      onProgress(
        Math.max(
          0,
          Math.min(100, Math.round((progress.loaded / progress.total) * 100))
        )
      );
  });
  onProgress(100);
}

export async function removeVoice(voiceId: string): Promise<void> {
  const piper = await import('@mintplex-labs/piper-tts-web');
  await piper.remove(voiceId);
}

export async function synthesizeChapter(
  text: string,
  voiceId: string,
  onProgress: (value: number, label: string) => void,
  shouldCancel: () => boolean,
  customApiKey?: string,
  cloudVoice?: string
): Promise<{ blob: Blob; duration: number; engineVoiceId: string }> {
  const stored = getStoredProviderConfig();
  const activeKey = (customApiKey || stored.apiKey || '').trim();
  let useRemote = Boolean(activeKey) || (await isRemoteTtsAvailable(false, activeKey));

  if (useRemote) {
    try {
      if (shouldCancel()) throw new Error('Génération annulée.');
      const providerLabel =
        stored.provider === 'deepinfra'
          ? 'DeepInfra · Kokoro'
          : stored.provider === 'aws-polly'
            ? 'Amazon Polly'
            : 'Gemini';
      const remoteChunks = chunkForSpeech(text, 280);
      const remoteBlobs: Blob[] = [];
      for (let index = 0; index < remoteChunks.length; index += 1) {
        if (shouldCancel()) throw new Error('Génération annulée.');
        onProgress(
          Math.round(12 + (index / Math.max(1, remoteChunks.length)) * 82),
          `${providerLabel} · segment ${index + 1}/${remoteChunks.length}`
        );
        remoteBlobs.push(
          await synthesizeRemoteChunk(remoteChunks[index], activeKey, cloudVoice)
        );
      }
      onProgress(96, `Assemblage du chapitre audio · ${providerLabel}`);
      const engineVoiceId = `${stored.provider || 'gemini'}:${cloudVoice || (stored.provider === 'deepinfra' ? 'ff_siwis' : stored.provider === 'aws-polly' ? 'Lea' : 'Kore')}`;

      if (remoteBlobs.every(blob => blob.type.includes('wav'))) {
        const merged = await mergeWavBlobs(remoteBlobs);
        onProgress(100, `Audio ${providerLabel} prêt`);
        return { ...merged, engineVoiceId };
      }

      const combinedBlob = new Blob(remoteBlobs, {
        type: remoteBlobs[0]?.type || 'audio/mpeg',
      });
      const estimatedDuration =
        Math.max(1, text.trim().split(/\s+/).length / 150) * 60;
      onProgress(100, `Audio ${providerLabel} prêt`);
      return {
        blob: combinedBlob,
        duration: estimatedDuration,
        engineVoiceId,
      };
    } catch (remoteError: any) {
      console.error('TTS distant erreur:', remoteError);
      if (activeKey) {
        throw new Error(
          remoteError?.message ||
            'Échec de la génération vocale distante. Vérifiez le fournisseur et les identifiants API.'
        );
      }
      useRemote = false;
    }
  }

  // Secours Piper TTS local
  const chunks = chunkForSpeech(text);
  const blobs: Blob[] = [];
  try {
    const piper = await import('@mintplex-labs/piper-tts-web');
    const stored = await piper.stored();
    const effectiveVoiceId = stored.includes(voiceId) ? voiceId : (stored[0] || voiceId);
    if (!stored.includes(effectiveVoiceId)) {
      onProgress(10, `Téléchargement de la voix locale (${effectiveVoiceId})...`);
      await piper.download(effectiveVoiceId, progress => {
        if (progress.loaded !== undefined && progress.total) {
          const downloadPart = progress.loaded / progress.total;
          onProgress(
            Math.round(10 + downloadPart * 30),
            `Téléchargement voix locale · ${Math.round(downloadPart * 100)} %`
          );
        }
      });
    }

    for (let index = 0; index < chunks.length; index += 1) {
      if (shouldCancel()) throw new Error('Génération annulée.');
      onProgress(
        Math.round(40 + (index / chunks.length) * 55),
        `Synthèse locale Piper · segment ${index + 1}/${chunks.length}`
      );
      const wav = await piper.predict(
        { text: chunks[index], voiceId: effectiveVoiceId },
        progress => {
          if (progress.loaded !== undefined && progress.total) {
            const part = progress.loaded / progress.total;
            onProgress(
              Math.round(40 + ((index + part) / chunks.length) * 55),
              `Synthèse vocale locale · ${Math.round(part * 100)} %`
            );
          }
        }
      );
      blobs.push(wav);
    }
    const merged = await mergeWavBlobs(blobs);
    return { ...merged, engineVoiceId: `piper:${effectiveVoiceId}` };
  } catch (piperErr: any) {
    console.error('Erreur Piper local:', piperErr);
    throw new Error(
      "Impossible de générer l’audio distant ni avec Piper local. Vérifiez votre connexion ou vos réglages API."
    );
  }
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
