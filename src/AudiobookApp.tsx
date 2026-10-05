import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Download,
  FileAudio,
  FileText,
  Headphones,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import type {
  AppSettings,
  AudioRecord,
  Book,
  Chapter,
  ImportProgress,
} from './types';
import {
  cleanExtractedText,
  formatBytes,
  sanitizeFileName,
  splitIntoChapters,
} from './lib/text';
import { extractPdf, renderPdfPageImage } from './lib/pdf';
import {
  CLOUD_THRESHOLD_BYTES,
  deleteCloudJob,
  generateCloudAudioStep,
  getCloudCapabilities,
  getCloudJob,
  processCloudStep,
  submitCloudOcrPage,
  uploadPdfToCloud,
  type CloudJobStatus,
} from './lib/cloud';
import {
  deleteAudio,
  deleteBook,
  getBookAudio,
  getBooks,
  putAudio,
  putBook,
} from './lib/storage';
import {
  downloadVoice,
  getStoredVoices,
  getVoiceCatalog,
  makeBookZip,
  removeVoice,
  synthesizeChapter,
  type VoiceCatalogItem,
} from './lib/tts';

const DEFAULT_SETTINGS: AppSettings = {
  rate: 1,
  voiceId: 'fr_FR-siwis-medium',
  systemVoiceUri: '',
  ocrLang: 'fra+eng',
  autoOcr: true,
};

const DEMO_TEXT = `Chapitre 1 — La porte entrouverte

Il était un peu plus de sept heures lorsque Noé aperçut la lumière sous la porte de l'atelier. D'habitude, la pièce restait fermée jusqu'au samedi. Ce matin-là, pourtant, quelqu'un avait laissé la clé dans la serrure.

Il poussa doucement. Sur la grande table, un carnet bleu attendait, ouvert à une page couverte d'une écriture minuscule. Au centre, une phrase était entourée trois fois : « Écoute avant de chercher à comprendre. »

Noé sourit. Cela ressemblait exactement au genre d'énigme que son grand-père aimait lui laisser.

Chapitre 2 — Une voix dans le casque

Dans le tiroir du bureau, il trouva un vieux casque audio relié à un petit lecteur. Une seule piste était disponible. Il appuya sur lecture et reconnut immédiatement la voix calme de son grand-père.

« Si tu entends ceci, c'est que tu as trouvé le carnet. Ne cours pas. Regarde autour de toi. Chaque détail compte davantage que la vitesse. »

Noé se retourna. Sur le mur, les cartes, les photographies et les notes semblaient soudain former un chemin.

Chapitre 3 — Le premier indice

Derrière une photographie du port, une enveloppe avait été glissée dans le cadre. À l'intérieur se trouvait une petite carte avec trois mots : bibliothèque, horloge, midi.

Cette fois, Noé ne chercha pas à deviner trop vite. Il rangea soigneusement le carnet dans son sac, remit le casque à sa place et sortit de l'atelier.

Le mystère pouvait commencer.`;

function uid(): string {
  return crypto.randomUUID();
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('livrevox-settings');
    return raw
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
      : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function buildBook(
  title: string,
  sourceName: string,
  sourceSize: number,
  pages: number,
  text: string,
  ocrUsed: boolean
): Book {
  const now = Date.now();
  return {
    id: uid(),
    title,
    sourceName,
    sourceSize,
    pages,
    createdAt: now,
    updatedAt: now,
    ocrUsed,
    chapters: splitIntoChapters(cleanExtractedText(text)),
    progress: {},
  };
}

export default function AudiobookApp() {
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [tab, setTab] = useState<'listen' | 'chapters' | 'export'>('listen');
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(
    null
  );
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [audioMap, setAudioMap] = useState<Record<string, AudioRecord>>({});
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogItem[]>([]);
  const [storedVoices, setStoredVoices] = useState<string[]>([]);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechState, setSpeechState] = useState<'idle' | 'playing' | 'paused'>(
    'idle'
  );
  const [speechProgress, setSpeechProgress] = useState(0);
  const [generation, setGeneration] = useState<{
    active: boolean;
    progress: number;
    label: string;
    mode: 'voice' | 'chapter' | 'book';
  } | null>(null);
  const [renameChapter, setRenameChapter] = useState<Chapter | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<{ fileName: string; incorrect: boolean } | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cancelGeneration = useRef(false);
  const passwordResolver = useRef<((password: string | null) => void) | null>(null);

  const selectedBook = useMemo(
    () => books.find(book => book.id === selectedId) ?? null,
    [books, selectedId]
  );
  const selectedChapter = useMemo(
    () =>
      selectedBook?.chapters.find(chapter => chapter.id === chapterId) ??
      selectedBook?.chapters[0] ??
      null,
    [selectedBook, chapterId]
  );
  const currentAudio =
    selectedBook && selectedChapter ? audioMap[selectedChapter.id] : undefined;
  const audioUrl = useMemo(
    () => (currentAudio ? URL.createObjectURL(currentAudio.blob) : ''),
    [currentAudio]
  );
  const generatedCount = selectedBook
    ? selectedBook.chapters.filter(chapter => audioMap[chapter.id] || chapter.audioUrl).length
    : 0;
  const isCloudBook = Boolean(selectedBook?.cloudJobId);
  const playableAudioUrl = selectedChapter?.audioUrl || audioUrl;
  const totalWords =
    selectedBook?.chapters.reduce((sum, chapter) => sum + chapter.words, 0) ??
    0;
  const totalMinutes =
    selectedBook?.chapters.reduce(
      (sum, chapter) => sum + chapter.estimatedMinutes,
      0
    ) ?? 0;

  useEffect(() => {
    void (async () => {
      try {
        const list = await getBooks();
        setBooks(list);
        if (list.length) {
          setSelectedId(list[0].id);
          setChapterId(list[0].chapters[0]?.id ?? '');
        }
        await navigator.storage?.persist?.();
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : 'Impossible de charger la bibliothèque.',
          true
        );
      }
    })();
  }, []);

  useEffect(() => {
    localStorage.setItem('livrevox-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!selectedBook) {
      setAudioMap({});
      return;
    }
    if (!selectedBook.chapters.some(chapter => chapter.id === chapterId))
      setChapterId(selectedBook.chapters[0]?.id ?? '');
    void getBookAudio(selectedBook.id).then(records =>
      setAudioMap(
        Object.fromEntries(records.map(record => [record.chapterId, record]))
      )
    );
  }, [selectedBook?.id]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    const refresh = () =>
      setSystemVoices(window.speechSynthesis?.getVoices?.() ?? []);
    refresh();
    window.speechSynthesis?.addEventListener?.('voiceschanged', refresh);
    return () =>
      window.speechSynthesis?.removeEventListener?.('voiceschanged', refresh);
  }, []);

  useEffect(() => {
    void refreshVoiceData();
    void getCloudCapabilities().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedBook?.cloudJobId) return;
    void getCloudJob(selectedBook.cloudJobId)
      .then(status => syncCloudStatus(status, selectedBook.id))
      .catch(() => undefined);
  }, [selectedBook?.cloudJobId]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = settings.rate;
  }, [settings.rate, audioUrl]);

  function showToast(message: string, error = false): void {
    let cleanMessage = message;
    if (
      message.includes('429') ||
      message.includes('RESOURCE_EXHAUSTED') ||
      message.includes('exceeded your current quota') ||
      message.includes('quota')
    ) {
      cleanMessage = 'Quota Gemini atteint : bascule automatique sur la voix locale Piper (illimitée et sans quota).';
    }
    setToast({ message: cleanMessage, error });
    window.setTimeout(() => setToast(null), 5500);
  }

  function requestPdfPassword(fileName: string, incorrect: boolean): Promise<string | null> {
    setPasswordValue('');
    setPasswordPrompt({ fileName, incorrect });
    return new Promise(resolve => {
      passwordResolver.current = resolve;
    });
  }

  function submitPdfPassword(): void {
    const password = passwordValue;
    if (!password) return;
    passwordResolver.current?.(password);
    passwordResolver.current = null;
    setPasswordPrompt(null);
    setPasswordValue('');
  }

  function cancelPdfPassword(): void {
    passwordResolver.current?.(null);
    passwordResolver.current = null;
    setPasswordPrompt(null);
    setPasswordValue('');
  }

  async function refreshVoiceData(): Promise<void> {
    try {
      const [catalog, stored] = await Promise.all([
        getVoiceCatalog(),
        getStoredVoices(),
      ]);
      setVoiceCatalog(catalog);
      setStoredVoices(stored);
      const selectedExists = catalog.some(
        voice => voice.id === settings.voiceId
      );
      if (!selectedExists) {
        const french = catalog.find(voice => voice.id.startsWith('fr_'));
        if (french)
          setSettings(current => ({ ...current, voiceId: french.id }));
      }
    } catch {
      setVoiceCatalog([
        {
          id: settings.voiceId,
          label: settings.voiceId.replace(/_/g, ' '),
          language: 'Français',
        },
      ]);
    }
  }

  function selectBook(book: Book): void {
    stopSpeech();
    setSelectedId(book.id);
    setChapterId(book.chapters[0]?.id ?? '');
    setTab('listen');
  }

  function cloudBookFromStatus(status: CloudJobStatus, existing?: Book): Book {
    const now = Date.now();
    return {
      id: existing?.id ?? `cloud-${status.id}`,
      title: status.title,
      sourceName: status.name,
      sourceSize: status.size,
      pages: status.pages,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ocrUsed: existing?.ocrUsed ?? false,
      chapters: status.chapters.map(chapter => ({ ...chapter })),
      progress: existing?.progress ?? {},
      cloudJobId: status.id,
      cloudStatus: status.status,
      cloudProcessingProgress: status.processingProgress,
      cloudAudioReady: status.audioReady,
      cloudTtsConfigured: status.ttsConfigured,
      cloudTtsProvider: status.ttsProvider,
    };
  }

  async function syncCloudStatus(status: CloudJobStatus, bookId?: string): Promise<Book> {
    const existing = books.find(book => book.id === bookId || book.cloudJobId === status.id);
    const updated = cloudBookFromStatus(status, existing);
    await putBook(updated);
    setBooks(current => {
      const found = current.some(book => book.id === updated.id);
      return found ? current.map(book => book.id === updated.id ? updated : book) : [updated, ...current];
    });
    if (selectedId === updated.id && updated.chapters.length && !updated.chapters.some(chapter => chapter.id === chapterId)) setChapterId(updated.chapters[0].id);
    return updated;
  }

  async function continueCloudPipeline(jobId: string, file: File | null, bookId: string): Promise<void> {
    let status = await getCloudJob(jobId);
    let safety = 0;
    while (safety < 500 && !['complete', 'failed', 'password_protected'].includes(status.status)) {
      safety += 1;
      if (status.status === 'waiting_ocr' && status.needsOcrPage) {
        if (!file) break;
        setImportProgress({ stage: `OCR cloud de la page ${status.needsOcrPage}`, progress: 62 + Math.round(status.processingProgress * 0.28) });
        const pageImage = await renderPdfPageImage(file, status.needsOcrPage, incorrect => requestPdfPassword(file.name, incorrect));
        status = await submitCloudOcrPage(jobId, status.needsOcrPage, pageImage);
      } else if (['queued', 'processing'].includes(status.status)) {
        status = await processCloudStep(jobId);
      } else if (status.ttsConfigured && status.audioReady < status.chapters.length) {
        status = await generateCloudAudioStep(jobId);
      } else {
        break;
      }
      await syncCloudStatus(status, bookId);
      if (status.pages) setImportProgress({ stage: status.ttsConfigured ? `Traitement cloud · ${status.processingProgress}% · audio ${status.audioReady}/${status.chapters.length}` : `Traitement cloud · ${status.processingProgress}%`, progress: 62 + Math.round(status.processingProgress * 0.37) });
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    setImportProgress(null);
    if (status.status === 'complete') showToast('Livre audio cloud prêt : les chapitres sont stockés et streamables.');
    else if (status.status === 'password_protected') showToast('PDF protégé détecté : LivreVox repasse automatiquement en traitement local sécurisé.', true);
    else if (status.status === 'text_ready' && !status.ttsConfigured) showToast('Texte cloud prêt. La voix cloud s’activera dès qu’une clé TTS sera configurée ; Piper reste disponible en secours.');
  }

  async function importLocalFile(file: File): Promise<void> {
    setImportProgress({ stage: 'Traitement local optimisé', progress: 1 });
    const result = await extractPdf(
      file,
      { autoOcr: settings.autoOcr, ocrLang: settings.ocrLang, requestPassword: incorrect => requestPdfPassword(file.name, incorrect) },
      setImportProgress
    );
    const cleaned = cleanExtractedText(result.text);
    if (cleaned.length < 120) throw new Error('Le PDF ne contient pas assez de texte exploitable.');
    const title = file.name.replace(/\.pdf$/i, '').trim() || 'Livre sans titre';
    const book = buildBook(title, file.name, file.size, result.pages, cleaned, result.ocrUsed);
    if (!book.chapters.length) throw new Error('Aucun chapitre exploitable n’a été détecté.');
    await putBook(book);
    setBooks(current => [book, ...current]);
    setSelectedId(book.id);
    setChapterId(book.chapters[0]?.id ?? '');
    setImportProgress({ stage: 'Livre prêt', progress: 100 });
    setTimeout(() => setImportProgress(null), 350);
    showToast(`${book.chapters.length} chapitre${book.chapters.length > 1 ? 's' : ''} prêt${book.chapters.length > 1 ? 's' : ''}.`);
  }

  async function importCloudFile(file: File): Promise<void> {
    setImportProgress({ stage: 'Préparation de l’envoi cloud', progress: 1 });
    const jobId = await uploadPdfToCloud(file, (stage, progress) => setImportProgress({ stage, progress }));
    let status = await getCloudJob(jobId);
    let initialSteps = 0;
    while (!status.chapters.length && initialSteps < 20 && !['failed', 'password_protected'].includes(status.status)) {
      initialSteps += 1;
      if (status.status === 'waiting_ocr' && status.needsOcrPage) {
        const pageImage = await renderPdfPageImage(file, status.needsOcrPage, incorrect => requestPdfPassword(file.name, incorrect));
        status = await submitCloudOcrPage(jobId, status.needsOcrPage, pageImage);
      } else {
        status = await processCloudStep(jobId);
      }
      setImportProgress({ stage: status.status === 'waiting_ocr' ? 'Préparation OCR cloud' : `Analyse cloud · ${status.processingProgress}%`, progress: 62 + Math.round(status.processingProgress * 0.25) });
    }
    if (status.status === 'password_protected') {
      await deleteCloudJob(jobId).catch(() => undefined);
      await importLocalFile(file);
      return;
    }
    if (status.status === 'failed') throw new Error(status.error || 'Le traitement cloud a échoué.');
    const book = await syncCloudStatus(status);
    setSelectedId(book.id);
    setChapterId(book.chapters[0]?.id ?? '');
    setImportProgress(null);
    showToast('Le premier contenu est prêt. Le reste du livre continue maintenant dans le cloud.');
    void continueCloudPipeline(jobId, file, book.id).catch(error => { setImportProgress(null); showToast(error instanceof Error ? error.message : 'Le traitement cloud a été interrompu.', true); });
  }

  async function importFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      showToast('Choisis un fichier PDF.', true);
      return;
    }
    try {
      if (file.size >= CLOUD_THRESHOLD_BYTES) await importCloudFile(file);
      else await importLocalFile(file);
    } catch (error) {
      setImportProgress(null);
      showToast(error instanceof Error ? error.message : 'Import du PDF impossible.', true);
    }
  }

  async function addDemo(): Promise<void> {
    const book = buildBook(
      'Le carnet bleu — Démo',
      'livre-demo.pdf',
      0,
      3,
      DEMO_TEXT,
      false
    );
    await putBook(book);
    setBooks(current => [book, ...current]);
    setSelectedId(book.id);
    setChapterId(book.chapters[0]?.id ?? '');
    showToast('Livre démo ajouté. Tu peux tester tout le lecteur.');
  }

  function stopSpeech(): void {
    window.speechSynthesis?.cancel();
    setSpeechState('idle');
    setSpeechProgress(0);
  }

  function toggleInstantSpeech(): void {
    if (!selectedChapter) return;
    if (!('speechSynthesis' in window)) {
      showToast(
        'La lecture vocale système n’est pas disponible dans ce navigateur.',
        true
      );
      return;
    }
    if (speechState === 'playing') {
      window.speechSynthesis.pause();
      setSpeechState('paused');
      return;
    }
    if (speechState === 'paused') {
      window.speechSynthesis.resume();
      setSpeechState('playing');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(selectedChapter.text);
    utterance.rate = settings.rate;
    const voice =
      systemVoices.find(item => item.voiceURI === settings.systemVoiceUri) ??
      systemVoices.find(item => item.lang.toLowerCase().startsWith('fr'));
    if (voice) utterance.voice = voice;
    utterance.onboundary = (event: SpeechSynthesisEvent) => {
      setSpeechProgress(
        Math.min(
          100,
          Math.round(
            (event.charIndex / Math.max(1, selectedChapter.text.length)) * 100
          )
        )
      );
    };
    utterance.onend = () => {
      setSpeechState('idle');
      setSpeechProgress(100);
    };
    utterance.onerror = () => {
      setSpeechState('idle');
      showToast('La voix système a interrompu la lecture.', true);
    };
    window.speechSynthesis.speak(utterance);
    setSpeechState('playing');
  }

  async function ensureVoiceReady(): Promise<boolean> {
    if (storedVoices.includes(settings.voiceId)) return true;
    setGeneration({
      active: true,
      progress: 0,
      label: 'Téléchargement du modèle vocal local',
      mode: 'voice',
    });
    try {
      await downloadVoice(settings.voiceId, progress =>
        setGeneration({
          active: true,
          progress,
          label: `Téléchargement de la voix · ${progress} %`,
          mode: 'voice',
        })
      );
      const stored = await getStoredVoices();
      setStoredVoices(stored);
      return true;
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : 'Impossible de télécharger la voix locale.',
        true
      );
      return false;
    } finally {
      setGeneration(null);
    }
  }

  async function generateOne(
    book: Book,
    chapter: Chapter,
    mode: 'chapter' | 'book'
  ): Promise<AudioRecord | null> {
    const ready = await ensureVoiceReady();
    if (!ready) return null;
    cancelGeneration.current = false;
    setGeneration({
      active: true,
      progress: 0,
      label: `Préparation de ${chapter.title}`,
      mode,
    });
    try {
      const result = await synthesizeChapter(
        chapter.text,
        settings.voiceId,
        (progress, label) =>
          setGeneration({ active: true, progress, label, mode }),
        () => cancelGeneration.current
      );
      const record: AudioRecord = {
        id: `${book.id}:${chapter.id}`,
        bookId: book.id,
        chapterId: chapter.id,
        voiceId: settings.voiceId,
        blob: result.blob,
        duration: result.duration,
        createdAt: Date.now(),
      };
      await putAudio(record);
      setAudioMap(current => ({ ...current, [chapter.id]: record }));
      return record;
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Génération audio impossible.',
        true
      );
      return null;
    } finally {
      setGeneration(null);
    }
  }

  async function generateCurrent(): Promise<void> {
    if (!selectedBook || !selectedChapter) return;
    const record = await generateOne(selectedBook, selectedChapter, 'chapter');
    if (record) showToast('Chapitre audio généré et enregistré localement.');
  }

  async function generateAll(): Promise<void> {
    if (!selectedBook) return;
    cancelGeneration.current = false;
    const ready = await ensureVoiceReady();
    if (!ready) return;
    let completed = 0;
    for (let index = 0; index < selectedBook.chapters.length; index += 1) {
      if (cancelGeneration.current) break;
      const chapter = selectedBook.chapters[index];
      if (audioMap[chapter.id]?.voiceId === settings.voiceId) {
        completed += 1;
        continue;
      }
      setGeneration({
        active: true,
        progress: Math.round((index / selectedBook.chapters.length) * 100),
        label: `Chapitre ${index + 1}/${selectedBook.chapters.length} · ${chapter.title}`,
        mode: 'book',
      });
      const record = await generateOne(selectedBook, chapter, 'book');
      if (!record) break;
      completed += 1;
    }
    setGeneration(null);
    if (!cancelGeneration.current && completed === selectedBook.chapters.length)
      showToast('Le livre audio complet est prêt à être exporté.');
  }

  async function exportBook(): Promise<void> {
    if (!selectedBook) return;
    const records = await getBookAudio(selectedBook.id);
    const map = Object.fromEntries(
      records.map(record => [record.chapterId, record])
    );
    const missing = selectedBook.chapters.filter(chapter => !map[chapter.id]);
    if (missing.length) {
      showToast(
        `Il reste ${missing.length} chapitre${missing.length > 1 ? 's' : ''} à générer.`,
        true
      );
      return;
    }
    setGeneration({
      active: true,
      progress: 30,
      label: 'Création de l’archive du livre audio',
      mode: 'book',
    });
    try {
      const zip = await makeBookZip(
        selectedBook.title,
        selectedBook.chapters.map((chapter, index) => ({
          index,
          title: chapter.title,
          blob: map[chapter.id].blob,
        }))
      );
      saveAs(zip, `${sanitizeFileName(selectedBook.title)} - Livre audio.zip`);
      showToast('Livre audio exporté en ZIP.');
    } finally {
      setGeneration(null);
    }
  }

  async function removeGeneratedChapter(chapter: Chapter): Promise<void> {
    if (!selectedBook) return;
    await deleteAudio(selectedBook.id, chapter.id);
    setAudioMap(current => {
      const next = { ...current };
      delete next[chapter.id];
      return next;
    });
    showToast('Audio local supprimé.');
  }

  async function renameSelectedChapter(): Promise<void> {
    if (!selectedBook || !renameChapter || !renameValue.trim()) return;
    const updated: Book = {
      ...selectedBook,
      updatedAt: Date.now(),
      chapters: selectedBook.chapters.map(chapter =>
        chapter.id === renameChapter.id
          ? { ...chapter, title: renameValue.trim() }
          : chapter
      ),
    };
    await putBook(updated);
    setBooks(current =>
      current.map(book => (book.id === updated.id ? updated : book))
    );
    setRenameChapter(null);
    showToast('Titre du chapitre enregistré.');
  }

  async function confirmDeleteBook(): Promise<void> {
    if (!deleteTarget) return;
    if (deleteTarget.cloudJobId) await deleteCloudJob(deleteTarget.cloudJobId).catch(() => undefined);
    await deleteBook(deleteTarget.id);
    const next = books.filter(book => book.id !== deleteTarget.id);
    setBooks(next);
    if (selectedId === deleteTarget.id) {
      setSelectedId(next[0]?.id ?? '');
      setChapterId(next[0]?.chapters[0]?.id ?? '');
    }
    setDeleteTarget(null);
    showToast(deleteTarget.cloudJobId ? 'Livre supprimé de cet appareil et du cloud.' : 'Livre supprimé de cet appareil.');
  }

  async function forgetVoice(): Promise<void> {
    if (!storedVoices.includes(settings.voiceId)) return;
    try {
      await removeVoice(settings.voiceId);
      await refreshVoiceData();
      showToast('Modèle vocal supprimé du stockage local.');
    } catch {
      showToast('Impossible de supprimer ce modèle vocal.', true);
    }
  }

  const frenchSystemVoices = systemVoices.filter(voice =>
    voice.lang.toLowerCase().startsWith('fr')
  );

  return (
    <div className="lv-app">
      <aside className="lv-sidebar">
        <div className="lv-brand">
          <div className="lv-logo">
            <Headphones size={20} />
          </div>
          <div>
            <strong>LivreVox</strong>
            <small>PDF → audio local</small>
          </div>
        </div>
        <button className="lv-primary" onClick={() => fileRef.current?.click()}>
          <Plus size={16} /> Importer un PDF
        </button>
        <div className="lv-section-label">Ma bibliothèque</div>
        <div className="lv-books">
          {books.length === 0 && (
            <div className="lv-empty-library">
              Tes livres apparaîtront ici et resteront enregistrés sur cet
              appareil.
            </div>
          )}
          {books.map(book => (
            <button
              key={book.id}
              className={`lv-book-item ${selectedId === book.id ? 'active' : ''}`}
              onClick={() => selectBook(book)}
            >
              <div className="lv-book-cover">
                <BookOpen size={16} />
              </div>
              <div className="lv-book-copy">
                <strong>{book.title}</strong>
                <span>
                  {book.chapters.length} chap. · ~
                  {book.chapters.reduce(
                    (sum, item) => sum + item.estimatedMinutes,
                    0
                  )}{' '}
                  min
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="lv-sidebar-bottom">
          <div className="lv-private-card">
            <LockKeyhole size={15} />
            <span>
              Mode hybride : petits PDF sur l’appareil, gros livres traités progressivement dans le cloud.
            </span>
          </div>
        </div>
      </aside>

      <main className="lv-main">
        <header className="lv-topbar">
          <div className="lv-mobile-brand">
            <Headphones size={17} />
          </div>
          <div className="lv-topbar-title">
            <strong>{selectedBook?.title ?? 'LivreVox'}</strong>
            <span>
              {selectedBook
                ? 'Bibliothèque locale'
                : 'Convertisseur PDF → livre audio'}
            </span>
          </div>
          <div className="lv-top-actions">
            <button
              className="lv-icon-button"
              title="Importer un PDF"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={17} />
            </button>
            <button
              className="lv-icon-button"
              title="Réglages"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={17} />
            </button>
          </div>
        </header>

        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={event => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = '';
          }}
        />

        <div className="lv-content">
          {!selectedBook ? (
            <section className="lv-empty">
              <div className="lv-hero">
                <div className="lv-badge">
                  <ShieldCheck size={13} /> Hybride · reprise progressive · streaming cloud
                </div>
                <h1>
                  Transforme ton PDF en <em>livre audio.</em>
                </h1>
                <p>
                  Importe un livre : les petits PDF restent rapides en local et les gros ouvrages passent automatiquement dans le cloud, par blocs, pour garder l’interface fluide. Les premiers chapitres arrivent avant la fin du traitement.
                </p>
                <div
                  className={`lv-drop ${dragging ? 'dragging' : ''}`}
                  onDragEnter={event => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={event => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={event => {
                    event.preventDefault();
                    setDragging(false);
                    const file = event.dataTransfer.files?.[0];
                    if (file) void importFile(file);
                  }}
                >
                  <div className="lv-drop-icon">
                    <FileText size={25} />
                  </div>
                  <strong>Dépose ton PDF ici</strong>
                  <span>PDF texte, mixte ou scanné · gros fichiers envoyés par blocs reprenables</span>
                  <div className="lv-drop-actions">
                    <button
                      className="lv-primary"
                      style={{ width: 'auto' }}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload size={15} /> Choisir un PDF
                    </button>
                    <button
                      className="lv-secondary"
                      onClick={() => void addDemo()}
                    >
                      <Sparkles size={15} /> Charger le livre démo
                    </button>
                  </div>
                </div>
                <div className="lv-features">
                  <div className="lv-feature">
                    <strong>
                      <WandSparkles size={14} /> Chapitrage automatique
                    </strong>
                    Détecte titres, parties et sections, avec découpage
                    intelligent si le PDF n’en contient pas.
                  </div>
                  <div className="lv-feature">
                    <strong>
                      <Zap size={14} /> OCR local
                    </strong>
                    Les pages scannées sont détectées automatiquement ; le rendu reste léger et la transcription OCR est effectuée dans le cloud.
                  </div>
                  <div className="lv-feature">
                    <strong>
                      <FileAudio size={14} /> Vrais fichiers WAV
                    </strong>
                    Génère chaque chapitre avec Piper, puis exporte le livre
                    complet dans une archive ZIP.
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <>
              <section className="lv-book-header">
                <div className="lv-book-heading">
                  <div className="lv-big-cover">
                    <BookOpen size={28} />
                  </div>
                  <div>
                    <h1>{selectedBook.title}</h1>
                    <div className="lv-meta">
                      <span>{selectedBook.pages || '—'} pages{selectedBook.cloudJobId ? ' · Cloud' : ' · Local'}</span>
                      <span>{totalWords.toLocaleString('fr-FR')} mots</span>
                      <span>~{totalMinutes} min</span>
                      <span>{formatBytes(selectedBook.sourceSize)}</span>
                      {selectedBook.ocrUsed && <span>OCR utilisé</span>}
                    </div>
                  </div>
                </div>
                <button
                  className="lv-secondary"
                  onClick={() => setDeleteTarget(selectedBook)}
                >
                  <Trash2 size={14} /> Supprimer
                </button>
              </section>

              <nav className="lv-tabs" aria-label="Sections du livre">
                <button
                  className={`lv-tab ${tab === 'listen' ? 'active' : ''}`}
                  onClick={() => setTab('listen')}
                >
                  Écouter
                </button>
                <button
                  className={`lv-tab ${tab === 'chapters' ? 'active' : ''}`}
                  onClick={() => setTab('chapters')}
                >
                  Chapitres
                </button>
                <button
                  className={`lv-tab ${tab === 'export' ? 'active' : ''}`}
                  onClick={() => setTab('export')}
                >
                  Générer & exporter
                </button>
              </nav>

              {tab === 'listen' && selectedChapter && (
                <section className="lv-reader">
                  <div className="lv-card lv-chapter-list">
                    {selectedBook.chapters.map((chapter, index) => (
                      <button
                        key={chapter.id}
                        className={`lv-chapter-row ${selectedChapter.id === chapter.id ? 'active' : ''}`}
                        onClick={() => {
                          stopSpeech();
                          setChapterId(chapter.id);
                        }}
                      >
                        <span className="lv-chapter-num">{index + 1}</span>
                        <span>
                          <strong>{chapter.title}</strong>
                          <span>
                            {chapter.words} mots · ~{chapter.estimatedMinutes}{' '}
                            min {audioMap[chapter.id] ? '· audio prêt' : ''}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="lv-reader-panel">
                    <article className="lv-card lv-reading-card">
                      <div className="lv-reading-top">
                        <div>
                          <h2>{selectedChapter.title}</h2>
                          <p>
                            {selectedChapter.words} mots · environ{' '}
                            {selectedChapter.estimatedMinutes} min
                          </p>
                        </div>
                        <span className="lv-status-pill">
                          {currentAudio
                            ? 'WAV local prêt'
                            : 'Lecture instantanée'}
                        </span>
                      </div>
                      <div className="lv-text">{selectedChapter.text}</div>
                    </article>

                    <div className="lv-card lv-player">
                      <div className="lv-player-main">
                        <button
                          className="lv-round"
                          aria-label={
                            speechState === 'playing'
                              ? 'Mettre en pause'
                              : 'Lire avec la voix système'
                          }
                          onClick={toggleInstantSpeech}
                        >
                          {speechState === 'playing' ? (
                            <Square size={17} />
                          ) : (
                            <Play size={18} fill="currentColor" />
                          )}
                        </button>
                        <button
                          className="lv-round subtle"
                          aria-label="Arrêter"
                          onClick={stopSpeech}
                        >
                          <CircleStop size={17} />
                        </button>
                      </div>
                      <div className="lv-progress">
                        <div className="lv-progress-track">
                          <div
                            className="lv-progress-fill"
                            style={{ width: `${speechProgress}%` }}
                          />
                        </div>
                        <div className="lv-player-label">
                          Voix système ·{' '}
                          {speechState === 'idle'
                            ? 'prête'
                            : speechState === 'paused'
                              ? 'en pause'
                              : 'lecture en cours'}
                        </div>
                      </div>
                      <select
                        aria-label="Vitesse de lecture"
                        className="lv-rate"
                        value={settings.rate}
                        onChange={event =>
                          setSettings(current => ({
                            ...current,
                            rate: Number(event.target.value),
                          }))
                        }
                      >
                        {[0.8, 1, 1.15, 1.3, 1.5, 1.75, 2].map(rate => (
                          <option key={rate} value={rate}>
                            {rate}×
                          </option>
                        ))}
                      </select>
                      {(currentAudio || selectedChapter.audioUrl) && (
                        <audio
                          ref={audioRef}
                          className="lv-audio"
                          controls
                          src={playableAudioUrl}
                          onPlay={() => {
                            if (audioRef.current)
                              audioRef.current.playbackRate = settings.rate;
                          }}
                        />
                      )}
                    </div>
                  </div>
                </section>
              )}

              {tab === 'chapters' && (
                <section className="lv-grid">
                  {selectedBook.chapters.map((chapter, index) => (
                    <div className="lv-card lv-info-card" key={chapter.id}>
                      <h3>
                        {index + 1}. {chapter.title}
                      </h3>
                      <p>
                        {chapter.words.toLocaleString('fr-FR')} mots · environ{' '}
                        {chapter.estimatedMinutes} min ·{' '}
                        {chapter.audioUrl ? 'audio cloud prêt' : audioMap[chapter.id] ? 'audio local généré' : 'pas encore généré'}
                      </p>
                      <div className="lv-card-actions">
                        <button
                          className="lv-secondary"
                          onClick={() => {
                            setChapterId(chapter.id);
                            setTab('listen');
                          }}
                        >
                          <Play size={13} /> Ouvrir
                        </button>
                        <button
                          className="lv-ghost"
                          onClick={() => {
                            setRenameChapter(chapter);
                            setRenameValue(chapter.title);
                          }}
                        >
                          <Pencil size={13} /> Renommer
                        </button>
                        {audioMap[chapter.id] && !chapter.audioUrl && (
                          <button
                            className="lv-ghost lv-danger"
                            onClick={() => void removeGeneratedChapter(chapter)}
                          >
                            <Trash2 size={13} /> Audio
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {tab === 'export' && (
                <section className="lv-export-stack">
                  <div className="lv-card lv-export-hero">
                    <div className="lv-badge">
                      <Volume2 size={13} /> {isCloudBook ? `Pipeline cloud · ${selectedBook.cloudTtsProvider || 'préparation'}` : 'Moteur neuronal local Piper'}
                    </div>
                    <h2>{isCloudBook ? 'Livre audio progressif dans le cloud' : 'Génère le vrai livre audio'}</h2>
                    <p>{isCloudBook ? `Le PDF est découpé, analysé et enregistré progressivement côté cloud. Les chapitres audio déjà générés sont conservés et streamés sans être recréés à chaque écoute. Traitement : ${selectedBook.cloudProcessingProgress ?? 0}%.` : 'Au premier lancement, le modèle vocal choisi est téléchargé puis conservé dans le stockage privé du navigateur. Le mode local reste disponible pour les petits documents et comme secours.'}</p>
                    <div className="lv-stat-grid">
                      <div className="lv-stat">
                        <strong>
                          {generatedCount}/{selectedBook.chapters.length}
                        </strong>
                        <span>chapitres prêts</span>
                      </div>
                      <div className="lv-stat">
                        <strong>
                          {isCloudBook ? (selectedBook.cloudTtsConfigured ? 'Actif' : 'Secours') : (storedVoices.includes(settings.voiceId) ? 'Oui' : 'Non')}
                        </strong>
                        <span>{isCloudBook ? 'moteur cloud' : 'voix en cache'}</span>
                      </div>
                      <div className="lv-stat">
                        <strong>{isCloudBook ? `${selectedBook.cloudAudioReady ?? 0}` : 'WAV'}</strong>
                        <span>{isCloudBook ? 'audios cloud prêts' : 'format audio'}</span>
                      </div>
                    </div>
                    <div className="lv-export-actions">
                      {isCloudBook ? (
                        <>
                          <button className="lv-primary" style={{ width: 'auto' }} onClick={() => selectedBook.cloudJobId && void continueCloudPipeline(selectedBook.cloudJobId, null, selectedBook.id)}>
                            <RotateCcw size={15} /> Reprendre le traitement cloud
                          </button>
                          {!selectedBook.cloudTtsConfigured && <button className="lv-secondary" disabled={!selectedChapter || Boolean(generation?.active)} onClick={() => void generateCurrent()}><WandSparkles size={15} /> Générer ce chapitre en local</button>}
                        </>
                      ) : (
                        <>
                          <button className="lv-primary" style={{ width: 'auto' }} disabled={!selectedChapter || Boolean(generation?.active)} onClick={() => void generateCurrent()}><WandSparkles size={15} /> Générer ce chapitre</button>
                          <button className="lv-secondary" disabled={Boolean(generation?.active)} onClick={() => void generateAll()}><RotateCcw size={15} /> Générer tout le livre</button>
                          <button className="lv-secondary" disabled={generatedCount !== selectedBook.chapters.length || Boolean(generation?.active)} onClick={() => void exportBook()}><Download size={15} /> Exporter le ZIP</button>
                        </>
                      )}
                    </div>
                    {generation && (
                      <div className="lv-generation">
                        <div className="lv-generation-row">
                          <span>{generation.label}</span>
                          <strong>{generation.progress}%</strong>
                        </div>
                        <div className="lv-progress-track">
                          <div
                            className="lv-progress-fill"
                            style={{ width: `${generation.progress}%` }}
                          />
                        </div>
                        {generation.mode === 'book' && (
                          <button
                            className="lv-ghost lv-danger"
                            style={{ marginTop: 10 }}
                            onClick={() => {
                              cancelGeneration.current = true;
                            }}
                          >
                            <X size={13} /> Annuler
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="lv-card lv-table">
                    {selectedBook.chapters.map((chapter, index) => (
                      <div className="lv-table-row" key={chapter.id}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <div>
                          <strong>{chapter.title}</strong>
                          <span>{chapter.words} mots</span>
                        </div>
                        <span>
                          {chapter.audioUrl || audioMap[chapter.id] ? 'Prêt' : 'À générer'}
                        </span>
                        <div className="lv-table-actions">
                          {chapter.audioUrl ? (
                            <a className="lv-mini-button" title="Ouvrir l’audio cloud" href={chapter.audioUrl} target="_blank" rel="noreferrer"><Play size={14} /></a>
                          ) : audioMap[chapter.id] ? (
                            <>
                              <button
                                className="lv-mini-button"
                                title="Télécharger le WAV"
                                onClick={() =>
                                  saveAs(
                                    audioMap[chapter.id].blob,
                                    `${String(index + 1).padStart(2, '0')} - ${sanitizeFileName(chapter.title)}.wav`
                                  )
                                }
                              >
                                <Download size={14} />
                              </button>
                              <button
                                className="lv-mini-button"
                                title="Supprimer l’audio"
                                onClick={() =>
                                  void removeGeneratedChapter(chapter)
                                }
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          ) : (
                            <button
                              className="lv-mini-button"
                              title="Générer ce chapitre"
                              onClick={() => {
                                setChapterId(chapter.id);
                                void generateOne(
                                  selectedBook,
                                  chapter,
                                  'chapter'
                                );
                              }}
                            >
                              <ChevronRight size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {importProgress && (
        <div className="lv-import-overlay">
          <div className="lv-card lv-import-box">
            <div className="lv-spinner" />
            <h3>{importProgress.stage}</h3>
            <p>{importProgress.stage.toLowerCase().includes('cloud') ? 'Le navigateur reste léger pendant que le serveur traite le livre.' : 'Le document est traité progressivement sans charger tout le fichier en mémoire.'}</p>
            <div className="lv-progress-track">
              <div
                className="lv-progress-fill"
                style={{ width: `${importProgress.progress}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className="lv-modal-wrap"
          onMouseDown={event => {
            if (event.currentTarget === event.target) setSettingsOpen(false);
          }}
        >
          <div className="lv-card lv-modal">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <h2>Réglages</h2>
              <button
                className="lv-icon-button"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p>Les réglages restent enregistrés dans ton navigateur.</p>
            <div className="lv-field">
              <label htmlFor="neural-voice">Voix neuronale locale</label>
              <select
                id="neural-voice"
                className="lv-select"
                value={settings.voiceId}
                onChange={event =>
                  setSettings(current => ({
                    ...current,
                    voiceId: event.target.value,
                  }))
                }
              >
                {(voiceCatalog.length
                  ? voiceCatalog
                  : [
                      {
                        id: settings.voiceId,
                        label: settings.voiceId,
                        language: 'Français',
                      },
                    ]
                ).map(voice => (
                  <option key={voice.id} value={voice.id}>
                    {voice.language} · {voice.label}
                  </option>
                ))}
              </select>
              <p>
                {storedVoices.includes(settings.voiceId)
                  ? 'Cette voix est déjà stockée localement.'
                  : 'Elle sera téléchargée automatiquement lors de la première génération.'}
              </p>
            </div>
            <div className="lv-field">
              <label htmlFor="system-voice">
                Voix système pour l’écoute instantanée
              </label>
              <select
                id="system-voice"
                className="lv-select"
                value={settings.systemVoiceUri}
                onChange={event =>
                  setSettings(current => ({
                    ...current,
                    systemVoiceUri: event.target.value,
                  }))
                }
              >
                <option value="">Automatique</option>
                {frenchSystemVoices.map(voice => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} · {voice.lang}
                  </option>
                ))}
              </select>
            </div>
            <div className="lv-field">
              <label htmlFor="ocr-lang">Langue OCR</label>
              <select
                id="ocr-lang"
                className="lv-select"
                value={settings.ocrLang}
                onChange={event =>
                  setSettings(current => ({
                    ...current,
                    ocrLang: event.target.value as AppSettings['ocrLang'],
                  }))
                }
              >
                <option value="fra+eng">Français + anglais</option>
                <option value="fra">Français</option>
                <option value="eng">Anglais</option>
              </select>
            </div>
            <div className="lv-field">
              <label className="lv-check">
                <input
                  type="checkbox"
                  checked={settings.autoOcr}
                  onChange={event =>
                    setSettings(current => ({
                      ...current,
                      autoOcr: event.target.checked,
                    }))
                  }
                />
                <span>
                  Activer automatiquement l’OCR local lorsque PDF.js ne trouve
                  presque aucun texte sur une page.
                </span>
              </label>
            </div>
            <div className="lv-modal-actions">
              {storedVoices.includes(settings.voiceId) && (
                <button
                  className="lv-ghost lv-danger"
                  onClick={() => void forgetVoice()}
                >
                  <Trash2 size={13} /> Oublier cette voix
                </button>
              )}
              <button
                className="lv-primary"
                style={{ width: 'auto' }}
                onClick={() => setSettingsOpen(false)}
              >
                Terminé
              </button>
            </div>
          </div>
        </div>
      )}

      {passwordPrompt && (
        <div className="lv-modal-wrap">
          <div className="lv-card lv-modal">
            <h2>{passwordPrompt.incorrect ? 'Mot de passe incorrect' : 'PDF protégé'}</h2>
            <p>
              {passwordPrompt.incorrect
                ? 'Le mot de passe saisi ne déverrouille pas ce PDF. Réessaie.'
                : `« ${passwordPrompt.fileName} » est protégé. Entre son mot de passe pour poursuivre l’import local.`}
            </p>
            <div className="lv-field">
              <label htmlFor="pdf-password">Mot de passe du PDF</label>
              <input
                id="pdf-password"
                className="lv-input"
                type="password"
                autoFocus
                autoComplete="off"
                value={passwordValue}
                onChange={event => setPasswordValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') submitPdfPassword();
                }}
              />
            </div>
            <div className="lv-modal-actions">
              <button className="lv-ghost" onClick={cancelPdfPassword}>Annuler</button>
              <button
                className="lv-primary"
                style={{ width: 'auto' }}
                disabled={!passwordValue}
                onClick={submitPdfPassword}
              >
                Ouvrir le PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {renameChapter && (
        <div className="lv-modal-wrap">
          <div className="lv-card lv-modal">
            <h2>Renommer le chapitre</h2>
            <div className="lv-field">
              <label htmlFor="chapter-title">Titre</label>
              <input
                id="chapter-title"
                className="lv-input"
                autoFocus
                value={renameValue}
                onChange={event => setRenameValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void renameSelectedChapter();
                }}
              />
            </div>
            <div className="lv-modal-actions">
              <button
                className="lv-ghost"
                onClick={() => setRenameChapter(null)}
              >
                Annuler
              </button>
              <button
                className="lv-primary"
                style={{ width: 'auto' }}
                disabled={!renameValue.trim()}
                onClick={() => void renameSelectedChapter()}
              >
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="lv-modal-wrap">
          <div className="lv-card lv-modal">
            <h2>Supprimer ce livre ?</h2>
            <p>
              « {deleteTarget.title} » et ses fichiers audio seront supprimés {deleteTarget.cloudJobId ? 'de cet appareil et du stockage cloud LivreVox' : 'du stockage local de cet appareil'}.
            </p>
            <div className="lv-modal-actions">
              <button
                className="lv-ghost"
                onClick={() => setDeleteTarget(null)}
              >
                Annuler
              </button>
              <button
                className="lv-secondary lv-danger"
                onClick={() => void confirmDeleteBook()}
              >
                <Trash2 size={13} /> Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`lv-toast ${toast.error ? 'error' : ''}`}>
          {toast.error ? <X size={15} /> : <CheckCircle2 size={15} />}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
