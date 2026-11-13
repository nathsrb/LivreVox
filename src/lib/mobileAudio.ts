import type { AudioRecord } from '../types';

// Safari on iPhone can be fragile when a large WAV Blob is assigned directly
// to an <audio> element. These are playback-only slices: the original audio
// stays untouched in IndexedDB and exports retain the original recording.
const MOBILE_WAV_LIMIT = 12 * 1024 * 1024;

type WavHeader = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
};

function isIOSWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function readWavHeader(blob: Blob): Promise<WavHeader | null> {
  const buffer = await blob.slice(0, Math.min(65536, blob.size)).arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 44) return null;
  const four = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (four(0) !== 'RIFF' || four(8) !== 'WAVE') return null;
  let offset = 12;
  let format: Omit<WavHeader, 'dataOffset' | 'dataSize'> | null = null;
  while (offset + 8 <= bytes.length) {
    const label = four(offset);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (label === 'fmt ' && size >= 16 && dataOffset + 16 <= bytes.length) {
      format = {
        audioFormat: view.getUint16(dataOffset, true),
        channels: view.getUint16(dataOffset + 2, true),
        sampleRate: view.getUint32(dataOffset + 4, true),
        byteRate: view.getUint32(dataOffset + 8, true),
        blockAlign: view.getUint16(dataOffset + 12, true),
        bitsPerSample: view.getUint16(dataOffset + 14, true),
      };
    }
    if (label === 'data' && format) {
      const dataSize = Math.min(
        size === 0xffffffff ? blob.size - dataOffset : size,
        blob.size - dataOffset
      );
      if (!format.byteRate || !format.blockAlign || dataSize <= 0) return null;
      return { ...format, dataOffset, dataSize };
    }
    const next = dataOffset + size + (size % 2);
    if (next <= offset) return null;
    offset = next;
  }
  return null;
}

function makeWavHeader(wav: WavHeader, dataBytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const ascii = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, wav.audioFormat, true);
  view.setUint16(22, wav.channels, true);
  view.setUint32(24, wav.sampleRate, true);
  view.setUint32(28, wav.byteRate, true);
  view.setUint16(32, wav.blockAlign, true);
  view.setUint16(34, wav.bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

/** Slice oversized PCM WAV files without decoding or copying the large audio payload. */
export async function splitLargeWavForPlayback(
  blob: Blob,
  maxBytes = MOBILE_WAV_LIMIT
): Promise<Array<{ blob: Blob; duration: number }> | null> {
  if (blob.size <= maxBytes) return null;
  const wav = await readWavHeader(blob);
  // Only standard PCM WAV is safe to re-header. Leave other formats untouched.
  if (!wav || wav.audioFormat !== 1 || wav.blockAlign < 1) return null;
  const maxDataBytes = Math.floor((maxBytes - 44) / wav.blockAlign) * wav.blockAlign;
  if (maxDataBytes < wav.blockAlign) return null;
  const parts: Array<{ blob: Blob; duration: number }> = [];
  for (let offset = 0; offset < wav.dataSize; offset += maxDataBytes) {
    const dataBytes = Math.floor(Math.min(maxDataBytes, wav.dataSize - offset) / wav.blockAlign) * wav.blockAlign;
    if (dataBytes <= 0) break;
    const header = makeWavHeader(wav, dataBytes);
    const slice = blob.slice(wav.dataOffset + offset, wav.dataOffset + offset + dataBytes);
    parts.push({
      blob: new Blob([header, slice], { type: 'audio/wav' }),
      duration: dataBytes / wav.byteRate,
    });
  }
  return parts.length > 1 ? parts : null;
}

/** Build a small-Blob playback view; never overwrite the saved full recording. */
export async function prepareAudioForMobile(record: AudioRecord): Promise<AudioRecord> {
  if (!isIOSWebKit()) return record;
  const originalParts = record.parts?.length ? record.parts : [record.blob];
  if (!originalParts.some(part => part.size > MOBILE_WAV_LIMIT)) return record;
  const playbackParts: Blob[] = [];
  const durations: number[] = [];
  let changed = false;
  for (let i = 0; i < originalParts.length; i++) {
    const part = originalParts[i];
    const split = await splitLargeWavForPlayback(part);
    if (split) {
      changed = true;
      for (const chunk of split) {
        playbackParts.push(chunk.blob);
        durations.push(chunk.duration);
      }
      continue;
    }
    playbackParts.push(part);
    const previousDuration = record.partDurations?.[i] ||
      (originalParts.length === 1 ? record.duration : 0);
    const wav = previousDuration ? null : await readWavHeader(part);
    durations.push(previousDuration || (wav ? wav.dataSize / wav.byteRate : 0));
  }
  if (!changed || durations.some(duration => !Number.isFinite(duration) || duration <= 0))
    return record;
  return {
    ...record,
    parts: playbackParts,
    partDurations: durations,
    duration: durations.reduce((sum, duration) => sum + duration, 0),
  };
}
