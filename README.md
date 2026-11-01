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


## Déploiement Netlify (novembre 2026)

L'application web Vite/React est publiée depuis `dist/`. Les clés IA restent sur les serveurs Netlify, dans les variables d'environnement avec le scope **Functions**, et ne sont jamais transmises dans le bundle client. La génération audio est servie via `/api/tts` en **stream binaire** (WAV/MP3), sans Base64 JSON. `/api/health`, `/api/voices`, `/api/validate-key` et `/api/chapters/summary` utilisent aussi une Netlify Function.

### Mise en route

1. Dans Netlify, importer le dépôt GitHub `nathsrb/LivreVox` (branche `main`). Les paramètres sont dans `netlify.toml` : commande `npm run build`, dossier public `dist`.
2. Dans **Project configuration → Environment variables**, ajouter `GEMINI_API_KEY` (marquer secret, scope **Functions**), `TTS_PROVIDER=gemini`, `GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts`, `GEMINI_TEXT_MODEL=gemini-3.8-flash`. Pour un autre fournisseur, ajouter la clé `DEEPINFRA_API_KEY` ou les deux clés AWS décrites dans `.env.example`.
3. Redéployer après l'ajout des variables. Vérifier `/api/health` : `ttsConfigured: true`, puis dans l'interface **Paramètres → Tester la connexion**. Le champ « Clé API » dans l'application est facultatif lorsque Netlify est configuré.
4. Contrôler une génération vocale réelle sur un court chapitre et l'écoute du résumé.

### Sécurité et limites

- Ne jamais utiliser de variables `VITE_GEMINI_API_KEY` : les variables préfixées `VITE_` sont intégrées au code public. Les requêtes Gemini, DeepInfra et Polly partent du backend.
- Les endpoints IA peuvent consommer du quota dès qu'un visiteur les utilise ; le débit est limité, mais pour une application privée ajouter aussi la protection d'accès Netlify.
- Netlify Functions a une durée maximale de requête. Les textes sont segmentés pour la génération audio et les réponses binaires évitent la limite des réponses JSON mises en mémoire.
- **Stockage local** : livres et audios restent dans l'IndexedDB du navigateur, propre au domaine. Les données déjà stockées sur l'URL AppDeploy ne migrent pas automatiquement vers Netlify : réimporter les PDF pour les retrouver sur le nouveau domaine.
- **Mode Cloud historique** : les traitements AppDeploy avec stockage cloud et les routes d'export GitHub côté serveur ne sont pas migrés. Cette version est *local-first* (PDF traité côté navigateur ; synthèse et résumés IA côté serveur Netlify).
- La voix Piper locale peut être bloquée si l'hébergement tiers de ses modèles réclame une vérification ; avec une clé IA Netlify valide, la génération Gemini/DeepInfra/Polly est prioritaire.

Pour le développement Netlify complet : `npx netlify dev` (la commande `npm run dev` continue d'utiliser l'ancien serveur Express de développement).
