# Prévisualisation Netlify — Auralis

**Branche de test :** `preview/netlify-auralis`.

Cette branche sert exclusivement aux prévisualisations. Ne pas la fusionner dans `main` sans validation.

- Netlify : projet `auralis-slnr`, équipe `revival-mentality7`.
- Source : `nathsrb/LivreVox`, branche `main` du dépôt existant.
- Paramètres de build : commande `npm run build`, sortie `dist`, `netlify.toml` à la racine.
- Variables déjà créées dans Netlify : `TTS_PROVIDER`, `GEMINI_TTS_MODEL`, `GEMINI_TEXT_MODEL`.
- À ajouter à la main comme secret de fonction : `GEMINI_API_KEY`.
- Pour une URL de prévisualisation Netlify du type `deploy-preview-<num>--auralis-slnr.netlify.app`, relier le dépôt GitHub au projet Netlify et activer les prévisualisations de PR.
- Les données stockées par l'ancienne URL AppDeploy dans IndexedDB ne suivent pas automatiquement.
- **Ne pas publier en production dans ce flux.** Seule la prévisualisation de cette PR est autorisée.

Une compilation et des vérifications réseau ne doivent pas être présentées comme des tests TTS réussis : elles nécessitent un déploiement effectif et une clé fournisseur valide.
