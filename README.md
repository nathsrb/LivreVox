# LivreVox

LivreVox transforme un PDF en livre audio. L'architecture principale est maintenant indépendante d'AppDeploy : le navigateur extrait le texte du PDF localement, puis appelle une API TTS générique `/api/tts`. Cette API peut être servie localement par Node, par une Function Netlify, ou par le même serveur Node sur un VPS/OVH.

## Architecture

- `src/` : frontend React/Vite, extraction PDF locale avec PDF.js, stockage local IndexedDB et lecteur audio.
- `src/lib/tts.ts` : synthèse audio. Utilise Gemini si `/api/health` annonce une clé configurée, sinon Piper reste disponible en secours local.
- `server/` : serveur Node portable pour le mode local ou un VPS. Il expose `/api/health` et `/api/tts` et peut servir le build `dist`.
- `netlify/functions/` : adaptateurs Netlify pour les mêmes routes `/api/health` et `/api/tts`.
- `backend/` : ancien backend AppDeploy conservé uniquement comme code legacy ; le fonctionnement principal de LivreVox n'en dépend plus.

Le PDF lui-même n'est plus envoyé à Gemini ou à AppDeploy. Le texte est extrait dans le navigateur puis découpé en petits segments avant la synthèse vocale.

## Prérequis

- Node.js 22.13 ou plus récent.
- Une clé Gemini API si tu veux la voix Gemini. Sans clé, Piper reste disponible localement.

## Lancement local

1. Clone le dépôt puis ouvre le dossier :

```bash
git clone https://github.com/nathsrb/LivreVox.git
cd LivreVox
```

2. Installe les dépendances :

```bash
npm install
```

3. Copie `.env.example` vers `.env`, puis ajoute ta clé :

```env
GEMINI_API_KEY=ta_cle_gemini
GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts
GEMINI_TTS_VOICE=Kore
PORT=8787
HOST=127.0.0.1
```

4. Lance le mode développement :

```bash
npm run dev
```

Vite sert l'interface et redirige automatiquement `/api/*` vers le serveur Node local.

## Mode production local ou VPS / OVH

```bash
npm install
npm run build
npm start
```

Le serveur Node sert alors le dossier `dist` et les routes API. Sur un serveur distant, définis généralement `HOST=0.0.0.0` et place Nginx/Caddy devant le port configuré.

## Netlify

Le dépôt contient déjà `netlify.toml` et les Functions nécessaires. Il suffit de connecter le dépôt à Netlify et d'ajouter dans les variables d'environnement :

- `GEMINI_API_KEY`
- `GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts` (optionnel)
- `GEMINI_TTS_VOICE=Kore` (optionnel)

Le build est `npm run build` et le dossier publié est `dist`.

## Gemini TTS

LivreVox utilise par défaut `gemini-3.8-flash-lite-tts`, adapté aux usages de lecture à haut débit. La réponse Gemini est lue via `interaction.output_audio`, avec compatibilité de secours pour l'ancien format `steps[].content[]`. Les erreurs 429 et 5xx sont retentées automatiquement.

## Validation

Le dépôt contient un workflow GitHub Actions qui vérifie :

- `npm install`
- `npx tsc --noEmit`
- `npm run build`
- la syntaxe de `server/gemini.mjs`
- la syntaxe de `server/index.mjs`

Le dernier build de validation est passé avec succès.
