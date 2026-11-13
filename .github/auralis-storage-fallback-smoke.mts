/** Offline test: a Safari quota exception must not discard generated paid audio. */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
const settings = new Map<string, string>([
  ['auralis-settings', JSON.stringify({ ttsProvider: 'deepinfra', apiKey: '', cloudVoice: 'ff_siwis' })],
]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => settings.get(key) ?? null,
    setItem: (key: string, value: string) => { settings.set(key, value); },
  },
});
const payloadSize = 96_000;
const wav = new Uint8Array(44 + payloadSize);
const view = new DataView(wav.buffer);
const ascii = (at: number, value: string) => {
  for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
};
ascii(0, 'RIFF');
view.setUint32(4, wav.length - 8, true);
ascii(8, 'WAVE');
ascii(12, 'fmt ');
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, 24000, true);
view.setUint32(28, 48000, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
ascii(36, 'data');
view.setUint32(40, payloadSize, true);

let calls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/health')) return Response.json({ ttsConfigured: true });
  if (url.includes('/api/tts')) {
    calls++;
    return new Response(wav.slice(), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
  throw new Error('Unexpected endpoint ' + url);
}) as typeof fetch;

const { synthesizeChapter } = await import('../src/lib/tts.ts');
// The store exists after the first indexedDB open. Reject all speech cache
// writes to simulate a real QuotaExceededError on iOS Safari.
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
  if (this.name === 'speech_segments') throw new DOMException('Site quota exceeded', 'QuotaExceededError');
  return originalPut.apply(this, args);
};
try {
  const lines = Array.from({ length: 8 }, (_, index) =>
    'Passage ' + (index + 1) + '. Le lecteur doit continuer à produire les sons même si le stockage local Safari refuse de les enregistrer.'
  ).join('\n\n');
  const progress: string[] = [];
  const result = await synthesizeChapter(lines, (_percent, label) => progress.push(label),
    () => false, '', 'ff_siwis', { bookId: 'quota-test', chapterId: 'chapter' });
  assert(calls > 0, 'No TTS chunks were generated');
  assert(result.cacheSaveFailed, 'Quota failure must be reported to the UI');
  assert(result.blob.size > 44, 'Generated audio was lost after quota failure');
  assert(progress.some(label => /Stockage local indisponible/.test(label)), 'No warning was emitted');
  console.log('SAFARI_STORAGE_FALLBACK_OK', { calls, generatedBytes: result.blob.size });
} finally {
  IDBObjectStore.prototype.put = originalPut;
}
