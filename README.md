# LivreVox — snapshot source complet

Ce dossier correspond au code source de la version hybride LivreVox exportée depuis le snapshot déployé AppDeploy.

## Variables d'environnement optionnelles

Le backend choisit automatiquement un moteur TTS cloud si l'une de ces variables est configurée côté serveur :

- `DEEPINFRA_API_KEY` : Kokoro-82M via DeepInfra
- `GEMINI_API_KEY` : Gemini TTS

Aucune clé secrète n'est incluse dans cette archive.

## Architecture

- `src/` : frontend React/Vite, traitement PDF local, OCR local, Piper local, IndexedDB.
- `backend/` : pipeline cloud, stockage par blocs, extraction progressive, OCR cloud et TTS cloud.
- `cron.json` : worker cloud périodique.
- `tests/` : scénarios QA AppDeploy.
- `LivreVox_TOUT_EN_UN.txt` : tous les fichiers source concaténés dans un seul fichier texte.

## Démarrage frontend classique

```bash
npm install
npm run dev
```

Les imports `@appdeploy/client` et `@appdeploy/sdk` sont fournis par la plateforme AppDeploy dans le déploiement actuel ; pour migrer vers un autre hébergeur, il faudra remplacer ces primitives par votre propre API, base de données et stockage.
