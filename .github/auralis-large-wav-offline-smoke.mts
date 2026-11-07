/**
 * One-off zero-cost high-volume integration test for the actual Auralis client
 * engine. Simulates huge PCM WAV outputs; does NOT call a paid TTS provider.
 */
import 'fake-indexeddb/auto';

const settings = new Map<string, string>();
settings.set('auralis-settings', JSON.stringify({ ttsProvider: 'deepinfra', apiKey: '', cloudVoice: 'ff_siwis' }));
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => settings.get(key) || null,
  setItem: (key: string, value: string) => { settings.set(key, value); },
} });
let networkCalls = 0;
function generateMockWav(): Uint8Array {
  const bytes = 12 * 1024 * 1024;
  const data = new Uint8Array(44 + bytes);
  const view = new DataView(data.buffer);
  const ascii = (pos: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
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
  view.setUint32(40, bytes, true);
  return data;
}
const wav = generateMockWav();
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/health')) return Response.json({ ttsConfigured: true });
  if (url.includes('/api/tts')) {
    networkCalls++;
    return new Response(wav.slice(), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
  throw new Error('Unexpected test endpoint: ' + url);
}) as typeof fetch;

const { synthesizeChapter } = await import('../src/lib/tts.ts');
const { getSpeechSegments, putAudio, getAudio } = await import('../src/lib/storage.ts');
const sentence = 'Au cours du voyage, le héros découvre les conséquences des choix effectués et poursuit son objectif. ';
const text = Array.from({ length: 104 }, (_, i) => (i+1) + ': ' + sentence).join('\n');
const context = { bookId: 'offline-huge-wav', chapterId: 'oversized-chapter' };
const result = await synthesizeChapter(text, () => {}, () => false, '', 'ff_siwis', context);
if (!result.parts || result.parts.length < 2) throw new Error('WAV was not divided into multiple playable parts');
if (!result.partDurations || result.partDurations.length !== result.parts.length)
  throw new Error('Missing durations for split audiobook parts');
if (result.parts.some(part => part.size > 80*1024*1024+500))
  throw new Error('A WAV part exceeds 80 MB safe maximum');
for (const part of result.parts) {
  const signature = String.fromCharCode(...new Uint8Array(await part.slice(0,4).arrayBuffer()));
  if (signature !== 'RIFF') throw new Error('A WAV part is corrupt');
}
const firstCalls = networkCalls;
const previouslySaved = await getSpeechSegments(context.bookId, context.chapterId);
if (previouslySaved.length < 8) throw new Error('Large chapter chunks were not cached');
const resumed = await synthesizeChapter(text, () => {}, () => false, '', 'ff_siwis', context);
if (networkCalls !== firstCalls) throw new Error('Resume re-generated cached audio');
await putAudio({
  id: context.bookId + ':' + context.chapterId,
  ...context,
  voiceId: result.engineVoiceId,
  blob: result.blob,
  parts: result.parts,
  partDurations: result.partDurations,
  duration: result.duration,
  createdAt: Date.now(),
});
const durable = await getAudio(context.bookId, context.chapterId);
if (!durable || durable.parts?.length !== result.parts.length)
  throw new Error('Split audio could not be read from IndexedDB');
console.log('LARGE_WAV_SUCCESS', JSON.stringify({
  audioCalls: firstCalls,
  resumedAdditionalCalls: networkCalls-firstCalls,
  parts: result.parts.length,
  bytes: result.parts.reduce((sum, part) => sum + part.size, 0),
  cachedSegments: previouslySaved.length,
}));
