import { geminiTts } from '../../server/gemini.mjs';

export default async (req: Request) => {
  if (req.method !== 'POST')
    return Response.json({ error: 'Method not allowed' }, { status: 405 });

  const apiKey = Netlify.env.get('GEMINI_API_KEY');
  if (!apiKey)
    return Response.json(
      { error: 'GEMINI_API_KEY absente dans les variables Netlify.' },
      { status: 503 }
    );

  try {
    const body = (await req.json()) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim())
      return Response.json({ error: 'Texte vide.' }, { status: 400 });
    if (text.length > 20_000)
      return Response.json(
        { error: 'Segment trop long. LivreVox doit découper le texte avant la synthèse.' },
        { status: 413 }
      );

    const result = await geminiTts(text, {
      apiKey,
      model: Netlify.env.get('GEMINI_TTS_MODEL') || undefined,
      voice: Netlify.env.get('GEMINI_TTS_VOICE') || undefined,
    });
    return Response.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('netlify_tts_failed', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Génération audio impossible.' },
      { status: 502 }
    );
  }
};

export const config = {
  path: '/api/tts',
};

declare const Netlify: {
  env: { get(name: string): string | undefined };
};
