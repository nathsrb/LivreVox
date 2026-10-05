const DEFAULT_MODEL = 'gemini-3.8-flash-lite-tts';
const DEFAULT_VOICE = 'Kore';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pickAudio(payload) {
  const direct = [
    payload?.interaction?.output_audio,
    payload?.interaction?.outputAudio,
    payload?.output_audio,
    payload?.outputAudio,
  ].find(Boolean);
  if (direct?.data) return direct;

  const fromSteps = payload?.steps
    ?.flatMap(step => step?.content ?? [])
    ?.filter(item => item?.type === 'audio' && item?.data)
    ?.at(-1);
  return fromSteps || null;
}

async function requestGemini(body, apiKey, attempts) {
  let lastMessage = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (response.ok) return response;

    const message = await response.text();
    lastMessage = `Gemini TTS ${response.status}: ${message}`;
    if (!RETRYABLE_STATUS.has(response.status) || attempt + 1 >= attempts)
      throw new Error(lastMessage);

    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 700 * 2 ** attempt;
    await sleep(Math.min(delay, 8000));
  }
  throw new Error(lastMessage || 'Gemini TTS indisponible.');
}

export async function geminiTts(text, options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY absente.');
  if (typeof text !== 'string' || !text.trim())
    throw new Error('Le texte à lire est vide.');

  const model = options.model || DEFAULT_MODEL;
  const voice = options.voice || DEFAULT_VOICE;
  const style =
    options.style ||
    'Narration de livre audio naturelle, chaleureuse, claire et régulière en français. Prononce fidèlement le texte sans commentaire supplémentaire.';

  const response = await requestGemini(
    {
      model,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: text.trim(),
              annotations: [{ type: 'speech_metadata', style }],
            },
          ],
        },
      ],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice }] },
    },
    apiKey,
    options.attempts || 4
  );

  const payload = await response.json();
  const audio = pickAudio(payload);
  if (!audio?.data)
    throw new Error('Gemini a répondu sans bloc audio exploitable.');

  return {
    audio: audio.data,
    mimeType: audio.mime_type || audio.mimeType || 'audio/wav',
    model,
    voice,
  };
}
