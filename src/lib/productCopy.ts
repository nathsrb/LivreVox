const replacements: Array<[RegExp, string]> = [
  [/Mode hybride : petits PDF sur l’appareil, gros livres traités progressivement dans le cloud\./gi, 'Tes livres restent disponibles dans ta bibliothèque, prêts à être écoutés.'],
  [/Hybride · reprise progressive · streaming cloud/gi, 'Conversion intelligente · écoute progressive'],
  [/Importe un livre : les petits PDF restent rapides en local et les gros ouvrages passent automatiquement dans le cloud, par blocs, pour garder l’interface fluide\. Les premiers chapitres arrivent avant la fin du traitement\./gi, 'Importe ton PDF, laisse LivreVox détecter les chapitres et commence à écouter dès que les premiers passages sont prêts.'],
  [/PDF texte, mixte ou scanné · gros fichiers envoyés par blocs reprenables/gi, 'PDF texte ou scanné · petits et grands livres pris en charge'],
  [/OCR local/gi, 'PDF scannés'],
  [/Les pages scannées sont détectées automatiquement ; le rendu reste léger et la transcription OCR est effectuée dans le cloud\./gi, 'Les pages scannées sont détectées et retranscrites automatiquement.'],
  [/Vrais fichiers WAV/gi, 'Audio chapitre par chapitre'],
  [/Génère chaque chapitre avec Piper, puis exporte le livre complet dans une archive ZIP\./gi, 'Écoute chaque chapitre dès qu’il est prêt et récupère ton livre audio complet.'],
  [/Bibliothèque locale/gi, 'Ma bibliothèque'],
  [/PDF → audio local/gi, 'PDF → livre audio'],
  [/ · Cloud/gi, ''],
  [/ · Local/gi, ''],
  [/OCR utilisé/gi, ''],
  [/WAV local prêt/gi, 'Audio prêt'],
  [/audio cloud prêt/gi, 'audio prêt'],
  [/audio local généré/gi, 'audio prêt'],
  [/Pipeline cloud · [^\n]+/gi, 'Conversion audio'],
  [/Moteur neuronal local Piper/gi, 'Conversion audio'],
  [/Livre audio progressif dans le cloud/gi, 'Transforme ton livre en audio'],
  [/Le PDF est découpé, analysé et enregistré progressivement côté cloud\. Les chapitres audio déjà générés sont conservés et streamés sans être recréés à chaque écoute\./gi, 'La conversion avance chapitre par chapitre. Tu peux commencer à écouter les passages déjà prêts pendant que le reste se termine.'],
  [/Au premier lancement, le modèle vocal choisi est téléchargé puis conservé dans le stockage privé du navigateur\. Le mode local reste disponible pour les petits documents et comme secours\./gi, 'Choisis une voix, génère un chapitre ou le livre entier, puis écoute ou exporte le résultat.'],
  [/moteur cloud/gi, 'audio disponible'],
  [/audios cloud prêts/gi, 'chapitres audio prêts'],
  [/Reprendre le traitement cloud/gi, 'Continuer la conversion'],
  [/Générer ce chapitre en local/gi, 'Générer ce chapitre'],
  [/Ouvrir l’audio cloud/gi, 'Écouter l’audio'],
  [/Traitement cloud/gi, 'Conversion'],
  [/Analyse cloud/gi, 'Analyse du livre'],
  [/OCR cloud/gi, 'Analyse'],
  [/Préparation OCR cloud/gi, 'Analyse des pages scannées'],
  [/Préparation de l’envoi cloud/gi, 'Préparation du livre'],
  [/Envoi cloud/gi, 'Envoi du livre'],
  [/Validation du fichier dans le cloud/gi, 'Préparation du livre'],
  [/Livre audio cloud prêt : les chapitres sont stockés et streamables\./gi, 'Ton livre audio est prêt.'],
  [/Le premier contenu est prêt\. Le reste du livre continue maintenant dans le cloud\./gi, 'Les premiers chapitres sont prêts. La conversion continue automatiquement.'],
  [/Le traitement cloud a été interrompu\./gi, 'La conversion a été interrompue.'],
  [/Le traitement cloud a échoué\./gi, 'La conversion du livre a échoué.'],
  [/PDF protégé détecté : LivreVox repasse automatiquement en traitement local sécurisé\./gi, 'Ce PDF est protégé. Entre son mot de passe pour continuer.'],
  [/Texte cloud prêt\. La voix cloud s’activera dès qu’une clé TTS sera configurée ; Piper reste disponible en secours\./gi, 'Le livre est prêt à être converti en audio.'],
  [/Traitement local optimisé/gi, 'Analyse du PDF'],
  [/Téléchargement du modèle vocal local/gi, 'Préparation de la voix'],
  [/Impossible de télécharger la voix locale\./gi, 'Impossible de préparer la voix.'],
  [/Chapitre audio généré et enregistré localement\./gi, 'Chapitre audio prêt.'],
  [/Audio local supprimé\./gi, 'Audio supprimé.'],
  [/Livre supprimé de cet appareil et du cloud\./gi, 'Livre supprimé.'],
  [/Livre supprimé de cet appareil\./gi, 'Livre supprimé.'],
  [/Modèle vocal supprimé du stockage local\./gi, 'Voix supprimée.'],
  [/Voix neuronale locale/gi, 'Voix du livre audio'],
  [/Cette voix est déjà stockée localement\./gi, 'Cette voix est prête.'],
  [/Langue OCR/gi, 'Langue du document'],
  [/Activer automatiquement l’OCR local lorsque PDF\.js ne trouve presque aucun texte sur une page\./gi, 'Détecter automatiquement le texte dans les pages scannées.'],
  [/pour poursuivre l’import local/gi, 'pour continuer'],
  [/du stockage cloud LivreVox/gi, 'de LivreVox'],
  [/du stockage local de cet appareil/gi, 'de LivreVox'],
  [/Ouvrir l’audio cloud/gi, 'Écouter l’audio'],
  [/Télécharger le WAV/gi, 'Télécharger l’audio'],
  [/Voix système pour l’écoute instantanée/gi, 'Voix pour l’écoute instantanée'],
  [/Voix système/gi, 'Lecture'],
];

function polish(value: string): string {
  let result = value;
  for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
  return result
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+·\s*$/g, '')
    .replace(/^\s*·\s+/g, '')
    .trim();
}

function polishNode(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const current = node.nodeValue ?? '';
    const next = polish(current);
    if (next !== current.trim()) node.nodeValue = next;
  }

  if (root instanceof Element) {
    for (const attribute of ['title', 'aria-label']) {
      const current = root.getAttribute(attribute);
      if (current) root.setAttribute(attribute, polish(current));
    }
  }
  if ('querySelectorAll' in root) {
    for (const element of Array.from(root.querySelectorAll('[title], [aria-label]'))) {
      for (const attribute of ['title', 'aria-label']) {
        const current = element.getAttribute(attribute);
        if (current) element.setAttribute(attribute, polish(current));
      }
    }
  }
}

export function enableProductCopyPolish(): () => void {
  const run = () => {
    if (document.body) polishNode(document.body);
  };

  run();
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData' && mutation.target.parentNode) {
        polishNode(mutation.target.parentNode);
      }
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) polishNode(node);
        else if (node.parentNode) polishNode(node.parentNode);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
