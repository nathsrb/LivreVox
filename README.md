# LivreVox / Auralis

LivreVox transforme un PDF en livre audio directement écoutable dans l’application.

## Flux principal

Le parcours prioritaire est volontairement simple :

1. l’utilisateur importe un PDF ;
2. PDF.js extrait le texte localement ;
3. LivreVox détecte les chapitres ;
4. si Gemini est configuré, le premier chapitre audio est généré automatiquement ;
5. l’écoute peut commencer immédiatement ;
6. les chapitres suivants sont générés progressivement en arrière-plan.

Si aucun moteur distant n’est disponible, Piper reste disponible comme secours local.

## Gemini TTS et choix des voix

Gemini est le fournisseur TTS par défaut.

LivreVox prend en charge :

- les 30 voix studio Gemini 3.8 TTS ;
- la bibliothèque de voix étendue via l’API Gemini Voices ;
- les IDs de voix personnalisées `voice_...` ;
- les clés de voix sans état `voicekey_...`.

L’utilisateur peut sélectionner une voix proposée dans les réglages ou saisir directement l’ID Gemini qu’il souhaite utiliser.

## Autres fournisseurs

Le routage historique reste disponible :

- **Google Gemini** — fournisseur par défaut et recommandé ;
- **DeepInfra + Kokoro** — alternative TTS ;
- **Amazon Polly** — fournisseur AWS ;
- **Piper local** — secours hors ligne.

## Architecture

- `src/AudiobookApp.tsx` : interface, import PDF, génération progressive, lecteur et réglages de voix ;
- `src/lib/pdf.ts` : extraction PDF / OCR ;
- `src/lib/tts.ts` : TTS, catalogue Gemini et fallback Piper ;
- `server.ts` : API Node pour Gemini, DeepInfra et Polly ;
- `src/lib/storage.ts` : bibliothèque et fichiers audio locaux.

Les clés API ne sont jamais codées en dur dans le dépôt.

## Lancement local

```bash
git clone https://github.com/nathsrb/LivreVox.git
cd LivreVox
npm install
cp .env.example .env
npm run dev
```

Une clé peut être configurée côté serveur ou saisie dans les réglages de l’application.

### Gemini

```env
TTS_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts
```

### DeepInfra

```env
TTS_PROVIDER=deepinfra
DEEPINFRA_API_KEY=...
```

### Amazon Polly

```env
TTS_PROVIDER=aws-polly
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=eu-west-3
```

## Validation

Chaque push sur `main` passe par GitHub Actions avec vérification TypeScript puis build Vite.
