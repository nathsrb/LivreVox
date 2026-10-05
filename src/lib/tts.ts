import { zipSync } from 'fflate';
import { chunkForSpeech, sanitizeFileName } from './text';

export type VoiceCatalogItem = {
  id: string;
  label: string;
  language: string;
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
  const piper = await import('@mintplex-labs/piper-tts-web');
  return piper.stored();
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
  shouldCancel: () => boolean
): Promise<{ blob: Blob; duration: number }> {
  const piper = await import('@mintplex-labs/piper-tts-web');
  const chunks = chunkForSpeech(text);
  const blobs: Blob[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (shouldCancel()) throw new Error('Génération annulée.');
    onProgress(
      Math.round((index / chunks.length) * 100),
      `Synthèse ${index + 1}/${chunks.length}`
    );
    const wav = await piper.predict(
      { text: chunks[index], voiceId },
      progress => {
        if (progress.loaded !== undefined && progress.total) {
          const downloadPart = progress.loaded / progress.total;
          onProgress(
            Math.round(((index + downloadPart) / chunks.length) * 100),
            `Préparation de la voix · ${Math.round(downloadPart * 100)} %`
          );
        }
      }
    );
    blobs.push(wav);
  }
  onProgress(96, 'Assemblage du chapitre');
  const merged = await mergeWavBlobs(blobs);
  onProgress(100, 'Chapitre prêt');
  return merged;
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
