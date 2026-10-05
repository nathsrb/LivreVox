export default async () => {
  const configured = Boolean(Netlify.env.get('GEMINI_API_KEY'));
  return Response.json(
    {
      ok: true,
      provider: configured ? 'gemini' : 'local-fallback',
      ttsConfigured: configured,
      model: Netlify.env.get('GEMINI_TTS_MODEL') || 'gemini-3.8-flash-lite-tts',
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
};

export const config = {
  path: '/api/health',
};

declare const Netlify: {
  env: { get(name: string): string | undefined };
};
