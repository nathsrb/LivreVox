# LivreVox

LivreVox transforme un PDF en livre audio sans dépendre de Google AI Studio.

Le PDF est lu localement dans le navigateur avec PDF.js. La synthèse vocale peut ensuite utiliser plusieurs fournisseurs interchangeables :

- **DeepInfra + Kokoro** — option économique recommandée ;
- **Google Gemini** — fournisseur optionnel ;
- **Amazon Polly** — fournisseur AWS ;
- **Piper local** — secours hors ligne, sans clé API.

## Principe

L’application n’est liée à aucun studio IA ni à un SDK propriétaire unique. Le fournisseur est choisi dans les réglages et les identifiants sont transmis au backend LivreVox au moment de la génération.

### Identifiants attendus

- DeepInfra : une clé API.
- Gemini : une clé API Gemini.
- Amazon Polly : un **AWS Access Key ID**, un **AWS Secret Access Key** et une région AWS, par exemple `eu-west-3`.

## Architecture

- `src/` : interface React/Vite, extraction PDF locale, bibliothèque locale et lecteur audio.
- `src/lib/tts.ts` : routage TTS vers le fournisseur choisi, avec Piper en secours.
- `server.ts` : serveur Node portable avec appels natifs aux APIs DeepInfra, Gemini et Amazon Polly.
- `backend/index.ts` : backend AppDeploy utilisé par la version déployée.
- Les clés ne sont pas codées en dur dans le dépôt.

## Lancement local

```bash
git clone https://github.com/nathsrb/LivreVox.git
cd LivreVox
npm install
cp .env.example .env
npm run dev
```

Tu peux aussi laisser le fichier `.env` vide et entrer tes identifiants directement dans les réglages de l’application.

## Configuration serveur

Exemple DeepInfra :

```env
TTS_PROVIDER=deepinfra
DEEPINFRA_API_KEY=...
```

Exemple Gemini :

```env
TTS_PROVIDER=gemini
GEMINI_API_KEY=...
```

Exemple Amazon Polly :

```env
TTS_PROVIDER=aws-polly
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=eu-west-3
```

## Résumés IA

Les résumés peuvent utiliser Gemini ou un modèle texte via DeepInfra. Amazon Polly reste uniquement un moteur de synthèse vocale.

## AppDeploy

Une version AppDeploy est maintenue séparément avec les mêmes choix de fournisseurs. Elle permet de renseigner les identifiants directement dans les réglages et utilise Piper lorsqu’aucune clé n’est fournie.
