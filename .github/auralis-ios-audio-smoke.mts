/**
 * Offline, zero-API-cost regression test for iPhone WAV playback slices.
 * Run: npx tsx .github/auralis-ios-audio-smoke.mts
 */
import assert from 'node:assert/strict';
import { prepareAudioForMobile, splitLargeWavForPlayback } from '../src/lib/mobileAudio.ts';
import type { AudioRecord } from '../src/types.ts';

const dataBytes = 27 * 1024 * 1024;
const sampleRate = 24000;
const byteRate = sampleRate * 2;
const header = new ArrayBuffer(44);
const view = new DataView(header);
function ascii(offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
ascii(0, 'RIFF');
view.setUint32(4, 36 + dataBytes, true);
ascii(8, 'WAVE');
ascii(12, 'fmt ');
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, sampleRate, true);
view.setUint32(28, byteRate, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
ascii(36, 'data');
view.setUint32(40, dataBytes, true);
const full = new Blob([header, new Uint8Array(dataBytes)], { type: 'audio/wav' });
const parts = await splitLargeWavForPlayback(full);
assert(parts && parts.length === 3, 'Oversized WAV should be divided into 3 smaller playable files');
let observedPayload = 0;
for (const part of parts) {
  assert(part.blob.size <= 12 * 1024 * 1024, 'A part exceeds the Safari size limit');
  const head = new DataView(await part.blob.slice(0, 44).arrayBuffer());
  assert.equal(head.getUint32(4, true) + 8, part.blob.size, 'RIFF length disagrees with blob size');
  assert.equal(head.getUint32(40, true), part.blob.size - 44, 'WAV data length is invalid');
  assert.equal(part.duration, (part.blob.size - 44) / byteRate, 'Incorrect chunk duration');
  observedPayload += part.blob.size - 44;
}
assert.equal(observedPayload, dataBytes, 'WAV slicing dropped or repeated PCM audio');
const saved: AudioRecord = {
  id: 'test:chapter',
  bookId: 'test',
  chapterId: 'chapter',
  voiceId: 'deepinfra:ff_siwis',
  blob: full,
  duration: dataBytes / byteRate,
  createdAt: Date.now(),
};
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
  });
  const prepared = await prepareAudioForMobile(saved);
  assert.equal(prepared.blob, full, 'Original recording must remain available for downloads');
  assert.equal(prepared.parts?.length, 3, 'Stored recording was not split for playback');
  assert(Math.abs(prepared.duration - saved.duration) < 0.001, 'Chapter duration changed');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux', maxTouchPoints: 0 },
  });
  assert.equal(await prepareAudioForMobile(saved), saved, 'Desktop playback should be untouched');
} finally {
  if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
}
const invalid = new Blob([new Uint8Array(13 * 1024 * 1024)], { type: 'audio/mpeg' });
assert.equal(await splitLargeWavForPlayback(invalid), null, 'Non-WAV audio must not be rewritten');
console.log('IOS_AUDIO_SMOKE_OK', { parts: parts.length, bytes: full.size, seconds: saved.duration });
