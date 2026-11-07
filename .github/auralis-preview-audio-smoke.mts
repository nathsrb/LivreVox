/**
 * One-off integration smoke (preview branch only).
 * Exercise the actual frontend chapter generator and IndexedDB cache in Node.
 * Synthetic French text; no private book contents or credentials.
 */
import 'fake-indexeddb/auto';

const preview = 'https://deploy-preview-2--auralis-slnr.netlify.app';
const memory = new Map<string, string>();
memory.set('auralis-settings', JSON.stringify({ ttsProvider: 'deepinfra', apiKey: '', cloudVoice: 'ff_siwis' }));
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem(key: string) { return memory.get(key) ?? null; },
  setItem(key: string, value: string) { memory.set(key, value); },
  removeItem(key: string) { memory.delete(key); },
} });
const nativeFetch = globalThis.fetch.bind(globalThis);
let calls = 0;
globalThis.fetch = ((target: RequestInfo | URL, init?: RequestInit) => {
  const resolved = typeof target === 'string' && target.startsWith('/') ? preview + target : target;
  if (String(resolved).endsWith('/api/tts')) calls++;
  return nativeFetch(resolved, init);
}) as typeof fetch;

const { synthesizeChapter, setPreferredSpeechRoute } = await import('../src/lib/tts.ts');
const { getSpeechSegments, saveSpeechSegment, putAudio, getAudio } = await import('../src/lib/storage.ts');
setPreferredSpeechRoute('openai');
const phrase = 'Dans cette histoire, un personnage poursuit un objectif. Sa décision transforme les événements, et chaque nouvelle scène apporte une conséquence inattendue. ';
const testText = Array.from({ length: 42 }, (_, i) => 'Étape ' + (i + 1) + '. ' + phrase).join('\n\n');
const bookId = 'live-smoke-book';
const chapterId = 'live-smoke-chapter';
const context = { bookId, chapterId };
const report: string[] = [];
const generated = await synthesizeChapter(
  testText, (progress: number, label: string) => {
    if (progress % 10 === 0) report.push(progress + '% ' + label);
  },
  () => false, '', 'ff_siwis', context
);
if (!generated.blob || generated.blob.size < 100_000 || generated.duration <= 0)
  throw new Error('Chapter WAV assembly failed or yielded empty audio');
const head = new Uint8Array(await generated.blob.slice(0, 4).arrayBuffer());
if (String.fromCharCode(...head) !== 'RIFF') throw new Error('Assembled result has no WAV header');
const checkpoint = await getSpeechSegments(bookId, chapterId);
if (checkpoint.filter((part: any) => part.voiceId.startsWith('deepinfra:')).length < 5)
  throw new Error('Audio chunks were not saved in IndexedDB');
const firstCallCount = calls;
console.log('E2E_GENERATED', JSON.stringify({
  chars: testText.length, calls: firstCallCount, saved: checkpoint.length,
  wavBytes: generated.blob.size, seconds: Math.round(generated.duration), voice: generated.engineVoiceId,
}));
const repeated = await synthesizeChapter(
  testText, () => undefined, () => false, '', 'ff_siwis', context
);
if (calls !== firstCallCount)
  throw new Error('Resume made fresh paid calls instead of using IndexedDB audio cache: ' + (calls - firstCallCount));
if (repeated.blob.size !== generated.blob.size)
  throw new Error('Resume WAV assembly differs from first generation');
const audioRecord = {
  id: bookId + ':' + chapterId, bookId, chapterId,
  voiceId: generated.engineVoiceId, blob: generated.blob,
  duration: generated.duration, createdAt: Date.now(),
  parts: generated.parts, partDurations: generated.partDurations,
};
await putAudio(audioRecord);
const reread = await getAudio(bookId, chapterId);
if (!reread || reread.blob.size !== generated.blob.size)
  throw new Error('Final audio was not durable in IndexedDB');
console.log('E2E_SUCCESS', JSON.stringify({
  initialCalls: firstCallCount, resumedExtraCalls: calls - firstCallCount,
  savedParts: checkpoint.length, durableBytes: reread.blob.size,
}));
