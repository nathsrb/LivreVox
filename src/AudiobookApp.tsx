import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  GitBranch,
  Headphones,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sparkles,
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
  CLOUD_VOICES,
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
  cloudVoice: 'Kore',
  ttsProvider: 'gemini',
  apiKey: '',
  apiSecret: '',
  awsRegion: 'eu-west-3',
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

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function loadSettings(): AppSettings {
  try {
    const rawA = localStorage.getItem('auralis-settings');
    const rawL = localStorage.getItem('livrevox-settings');
    const directKey =
      localStorage.getItem('auralis_gemini_api_key') ||
      localStorage.getItem('gemini_api_key');
    const parsedA = rawA ? (JSON.parse(rawA) as Partial<AppSettings>) : {};
    const parsedL = rawL ? (JSON.parse(rawL) as Partial<AppSettings>) : {};
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...parsedL, ...parsedA };
    if (directKey && directKey.trim() && !merged.apiKey) {
      merged.apiKey = directKey.trim();
      merged.geminiApiKey = directKey.trim();
    }
    const savedRate = localStorage.getItem('auralis_playback_rate');
    if (savedRate && !isNaN(Number(savedRate))) merged.rate = Number(savedRate);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function renderFormattedSummary(text: string) {
  const sections = text.split(/(?=### )/g).filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {sections.map((sec, idx) => {
        const lines = sec.trim().split('\n');
        const header = lines[0].replace(/^###\s*/, '').trim();
        const body = lines.slice(1).join('\n').replace(/^---\s*$/gm, '').trim();
        const isHighlight = header.includes('30 secondes') || header.includes('retenir qu’une seule chose');

        return (
          <div key={idx} className={`lv-summary-section ${isHighlight ? 'lv-summary-highlight-box' : ''}`}>
            <h3>{header}</h3>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px', lineHeight: 1.65 }}>
              {body}
            </div>
          </div>
        );
      })}
    </div>
  );
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
  const [tab, setTab] = useState<'listen' | 'chapters' | 'summary' | 'export'>('listen');
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
  const [deleteChapterTarget, setDeleteChapterTarget] = useState<Chapter | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [keyTestStatus, setKeyTestStatus] = useState<'idle' | 'testing' | 'valid' | 'invalid'>('idle');
  const [keyTestError, setKeyTestError] = useState<string | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<{ fileName: string; incorrect: boolean } | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cancelGeneration = useRef(false);
  const passwordResolver = useRef<((password: string | null) => void) | null>(null);

  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isImmersiveOpen, setIsImmersiveOpen] = useState(false);
  const [autoPlayNext, setAutoPlayNext] = useState(true);
  const [dockedDismissed, setDockedDismissed] = useState(false);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [githubToken, setGithubToken] = useState(() => localStorage.getItem('auralis_github_token') || '');
  const [githubSyncing, setGithubSyncing] = useState(false);
  const [githubSyncResult, setGithubSyncResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState<number | null>(null);
  const [resumeState, setResumeState] = useState<{
    bookId: string;
    chapterId: string;
    currentTime: number;
    duration: number;
    rate: number;
    bookTitle: string;
    chapterTitle: string;
    timestamp: number;
  } | null>(() => {
    try {
      const raw = localStorage.getItem('auralis_resume_state');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

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

  const paragraphs = useMemo(() => {
    if (!selectedChapter?.text) return [];
    return selectedChapter.text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }, [selectedChapter?.text]);

  const activeParagraphIndex = useMemo(() => {
    if (!paragraphs.length) return 0;
    const progress =
      playableAudioUrl && audioDuration > 0
        ? audioCurrentTime / audioDuration
        : speechProgress / 100;
    return Math.min(
      paragraphs.length - 1,
      Math.floor(progress * paragraphs.length)
    );
  }, [paragraphs.length, playableAudioUrl, audioDuration, audioCurrentTime, speechProgress]);

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
    localStorage.setItem('auralis-settings', JSON.stringify(settings));
    localStorage.setItem('livrevox-settings', JSON.stringify(settings));
    if (settings.apiKey?.trim()) {
      localStorage.setItem('auralis_api_key', settings.apiKey.trim());
      if ((settings.ttsProvider || 'gemini') === 'gemini') {
        localStorage.setItem('auralis_gemini_api_key', settings.apiKey.trim());
        localStorage.setItem('gemini_api_key', settings.apiKey.trim());
      }
    }
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

  // Enregistrement régulier de la position de reprise
  useEffect(() => {
    if (!audioPlaying || !selectedBook || !selectedChapter) return;
    const interval = setInterval(() => {
      if (audioRef.current && audioRef.current.currentTime > 2) {
        localStorage.setItem(
          'auralis_resume_state',
          JSON.stringify({
            bookId: selectedBook.id,
            chapterId: selectedChapter.id,
            currentTime: Math.floor(audioRef.current.currentTime),
            duration: Math.floor(audioRef.current.duration || 0),
            rate: settings.rate,
            bookTitle: selectedBook.title,
            chapterTitle: selectedChapter.title,
            timestamp: Date.now(),
          })
        );
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [audioPlaying, selectedBook?.id, selectedChapter?.id, settings.rate]);

  // Support Media Session API (écran verrouillé et contrôles multimédias)
  useEffect(() => {
    if (!('mediaSession' in navigator) || !selectedBook || !selectedChapter) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: selectedChapter.title,
        artist: 'Auralis',
        album: selectedBook.title,
      });
      navigator.mediaSession.setActionHandler('play', () => {
        void audioRef.current?.play().catch(() => undefined);
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audioRef.current?.pause();
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        handleSkip(-15);
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        handleSkip(15);
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        goToPrevChapter();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        goToNextChapter(false);
      });
      navigator.mediaSession.setActionHandler('seekto', details => {
        if (details.seekTime !== undefined && audioRef.current) {
          seekTo(details.seekTime);
        }
      });
    } catch {
      // Ignorer si le navigateur ne supporte pas certaines actions
    }
  }, [selectedBook?.title, selectedChapter?.title]);

  useEffect(() => {
    if (sleepTimerMinutes === null) {
      setSleepRemainingSeconds(null);
      return;
    }
    setSleepRemainingSeconds(sleepTimerMinutes * 60);
    const interval = setInterval(() => {
      setSleepRemainingSeconds(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          if (audioRef.current) audioRef.current.pause();
          window.speechSynthesis?.cancel();
          setSpeechState('idle');
          setAudioPlaying(false);
          setSleepTimerMinutes(null);
          showToast('Minuterie de veille : lecture mise en pause.');
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [sleepTimerMinutes]);

  function showToast(message: string, error = false): void {
    let cleanMessage = message;
    if (
      message.includes('429') ||
      message.includes('RESOURCE_EXHAUSTED') ||
      message.includes('exceeded your current quota')
    ) {
      cleanMessage = 'Débit temporaire IA atteint (429). Conseil : utilisez « Voix directe » pour écouter immédiatement sans attente.';
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
    stopAllPlayback();
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
    else if (status.status === 'password_protected') showToast('PDF protégé détecté : Auralis repasse automatiquement en traitement local sécurisé.', true);
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

  function formatTime(totalSeconds: number): string {
    if (!totalSeconds || isNaN(totalSeconds) || totalSeconds < 0) return '0:00';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function stopSpeech(): void {
    window.speechSynthesis?.cancel();
    setSpeechState('idle');
    setSpeechProgress(0);
  }

  function stopAllPlayback(): void {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setAudioPlaying(false);
    setAudioCurrentTime(0);
    stopSpeech();
  }

  function updateRate(newRate: number): void {
    setSettings(current => ({ ...current, rate: newRate }));
    localStorage.setItem('auralis_playback_rate', String(newRate));
    if (audioRef.current) audioRef.current.playbackRate = newRate;
  }

  function handleResume(): void {
    if (!resumeState) return;
    const targetBook = books.find(b => b.id === resumeState.bookId);
    if (!targetBook) {
      setResumeState(null);
      localStorage.removeItem('auralis_resume_state');
      return;
    }
    setSelectedId(targetBook.id);
    const targetChapter = targetBook.chapters.find(c => c.id === resumeState.chapterId) || targetBook.chapters[0];
    if (targetChapter) {
      setChapterId(targetChapter.id);
      setTab('listen');
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.currentTime = resumeState.currentTime;
          audioRef.current.playbackRate = resumeState.rate || settings.rate;
          void audioRef.current.play().catch(() => undefined);
          setAudioPlaying(true);
        }
      }, 350);
    }
    setResumeState(null);
    showToast(`Reprise de « ${resumeState.chapterTitle} »`);
  }

  async function confirmDeleteChapter(): Promise<void> {
    if (!selectedBook || !deleteChapterTarget) return;
    if (selectedBook.chapters.length <= 1) {
      showToast('Impossible de supprimer le seul chapitre restant de ce livre.', true);
      setDeleteChapterTarget(null);
      return;
    }
    const target = deleteChapterTarget;
    const remaining = selectedBook.chapters.filter(c => c.id !== target.id);
    await deleteAudio(selectedBook.id, target.id).catch(() => undefined);
    const updated: Book = {
      ...selectedBook,
      updatedAt: Date.now(),
      chapters: remaining,
    };
    await putBook(updated);
    setBooks(current => current.map(b => (b.id === updated.id ? updated : b)));
    if (chapterId === target.id) {
      setChapterId(remaining[0].id);
      setAudioCurrentTime(0);
    }
    setDeleteChapterTarget(null);
    showToast(`Chapitre « ${target.title} » supprimé.`);
  }

  async function generateCurrentAndPlay(): Promise<void> {
    if (!selectedBook || !selectedChapter) return;
    showToast(`Génération de la voix IA pour « ${selectedChapter.title} »...`);
    const record = await generateOne(selectedBook, selectedChapter, 'chapter');
    if (record) {
      showToast(`Audio IA prêt ! Démarrage de l'écoute.`);
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          void audioRef.current.play().catch(() => undefined);
          setAudioPlaying(true);
        }
      }, 300);
    }
  }

  function togglePlayPause(): void {
    if (playableAudioUrl && audioRef.current) {
      if (audioPlaying) {
        audioRef.current.pause();
      } else {
        stopSpeech();
        void audioRef.current.play().catch(e => {
          console.error('Audio playback error:', e);
        });
      }
    } else {
      void generateCurrentAndPlay();
    }
  }

  async function generateChapterSummary(chapter: Chapter): Promise<void> {
    if (!selectedBook) return;
    setSummaryLoading(true);
    try {
      const chapterIndex = selectedBook.chapters.findIndex(c => c.id === chapter.id);
      const prevContext = selectedBook.chapters
        .slice(0, chapterIndex)
        .map((c, i) => `Chapitre ${i + 1} : ${c.title}`)
        .join(', ');

      const res = await fetch('/api/chapters/summary', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
          ...(settings.apiSecret ? { 'x-api-secret': settings.apiSecret } : {}),
          'x-tts-provider': settings.ttsProvider || 'gemini',
          ...(settings.awsRegion ? { 'x-aws-region': settings.awsRegion } : {}),
        },
        body: JSON.stringify({
          chapterText: chapter.text,
          chapterTitle: chapter.title,
          bookTitle: selectedBook.title,
          previousChaptersContext: prevContext,
          customApiKey: settings.apiKey,
          provider: settings.ttsProvider || 'gemini',
          apiSecret: settings.apiSecret,
          region: settings.awsRegion,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Erreur lors de la génération du résumé');
      }

      const data = await res.json();
      const summaryText = data.summary;

      const updatedBook: Book = {
        ...selectedBook,
        updatedAt: Date.now(),
        chapters: selectedBook.chapters.map(c =>
          c.id === chapter.id ? { ...c, summary: summaryText } : c
        ),
      };
      await putBook(updatedBook);
      setBooks(current => current.map(b => (b.id === updatedBook.id ? updatedBook : b)));
      showToast('✨ Résumé IA généré avec succès !');
    } catch (err: any) {
      showToast(err?.message || 'Erreur lors du résumé IA', true);
    } finally {
      setSummaryLoading(false);
    }
  }

  async function playSummaryWithIA(summaryText: string): Promise<void> {
    if (!summaryText) return;
    stopAllPlayback();
    showToast('Synthèse vocale IA pour le résumé...');
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
          ...(settings.apiSecret ? { 'x-api-secret': settings.apiSecret } : {}),
          'x-tts-provider': settings.ttsProvider || 'gemini',
          ...(settings.awsRegion ? { 'x-aws-region': settings.awsRegion } : {}),
        },
        body: JSON.stringify({
          text: summaryText.replace(/###|---|\*\*|⚡|📖|🧠|👥|💡|🔗|🎯/g, ' ').slice(0, 15000),
          voice: settings.cloudVoice || 'Kore',
        }),
      });
      if (!res.ok) throw new Error('Échec synthèse résumé');
      const data = await res.json();
      const clean = data.audio.includes(',') ? data.audio.slice(data.audio.indexOf(',') + 1) : data.audio;
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.currentTime = 0;
        void audioRef.current.play();
        setAudioPlaying(true);
        showToast('Lecture du résumé IA lancée');
      }
    } catch (err: any) {
      showToast(err?.message || 'Erreur lecture résumé', true);
    }
  }

  async function testApiKey(): Promise<void> {
    const key = (settings.apiKey || '').trim();
    if (!key) {
      showToast('Veuillez saisir votre clé API d’abord.', true);
      return;
    }
    setKeyTestStatus('testing');
    setKeyTestError(null);
    try {
      const res = await fetch('/api/validate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: settings.ttsProvider || 'gemini',
          apiKey: key,
          apiSecret: settings.apiSecret,
          region: settings.awsRegion,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setKeyTestStatus('valid');
        localStorage.setItem('auralis_api_key', key);
        showToast(`✓ Identifiants validés pour ${settings.ttsProvider || 'gemini'}.`);
      } else {
        setKeyTestStatus('invalid');
        setKeyTestError(data.error || 'Clé non valide.');
        showToast(data.error || 'Identifiants API invalides.', true);
      }
    } catch (err: any) {
      setKeyTestStatus('invalid');
      setKeyTestError(err?.message || 'Erreur de connexion');
      showToast(err?.message || 'Erreur lors du test de la clé', true);
    }
  }

  async function handleGithubPush(): Promise<void> {
    const token = githubToken.trim();
    if (!token) {
      showToast('Veuillez saisir votre jeton GitHub (PAT).', true);
      return;
    }
    setGithubSyncing(true);
    setGithubSyncResult(null);
    try {
      localStorage.setItem('auralis_github_token', token);
      const res = await fetch('/api/github/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          repoUrl: 'https://github.com/nathsrb/LivreVox.git',
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setGithubSyncResult({ ok: true, message: data.message || 'Synchronisé avec succès !' });
        showToast('✓ Code synchronisé sur GitHub (main) !');
      } else {
        setGithubSyncResult({ ok: false, message: data.error || 'Erreur lors de la synchronisation GitHub.' });
        showToast(data.error || 'Erreur push GitHub', true);
      }
    } catch (err: any) {
      const msg = err?.message || 'Erreur réseau lors de la synchronisation';
      setGithubSyncResult({ ok: false, message: msg });
      showToast(msg, true);
    } finally {
      setGithubSyncing(false);
    }
  }

  function handleSkip(seconds: number): void {
    if (playableAudioUrl && audioRef.current) {
      const target = Math.max(0, Math.min(audioDuration, (audioRef.current.currentTime || 0) + seconds));
      audioRef.current.currentTime = target;
      setAudioCurrentTime(target);
    } else if (speechState === 'playing') {
      showToast(seconds > 0 ? '+15s (disponible sur l’audio généré)' : '-15s (disponible sur l’audio généré)');
    }
  }

  function seekTo(target: number): void {
    if (playableAudioUrl && audioRef.current) {
      audioRef.current.currentTime = target;
      setAudioCurrentTime(target);
    }
  }

  function goToNextChapter(autoStart = false): void {
    if (!selectedBook || !selectedChapter) return;
    const currentIndex = selectedBook.chapters.findIndex(c => c.id === selectedChapter.id);
    if (currentIndex < selectedBook.chapters.length - 1) {
      const next = selectedBook.chapters[currentIndex + 1];
      setChapterId(next.id);
      setAudioCurrentTime(0);
      if (autoStart) {
        setTimeout(() => {
          if (audioRef.current && (next.audioUrl || audioMap[next.id])) {
            void audioRef.current.play().catch(() => undefined);
            setAudioPlaying(true);
          } else {
            void generateCurrentAndPlay();
          }
        }, 280);
      }
    } else {
      showToast('🎉 Livre terminé ! Félicitations pour votre écoute.');
    }
  }

  function goToPrevChapter(): void {
    if (!selectedBook || !selectedChapter) return;
    const currentIndex = selectedBook.chapters.findIndex(c => c.id === selectedChapter.id);
    if (currentIndex > 0) {
      const prev = selectedBook.chapters[currentIndex - 1];
      setChapterId(prev.id);
      setAudioCurrentTime(0);
    }
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
    if (settings.apiKey?.trim() || localStorage.getItem('auralis_api_key') || localStorage.getItem('auralis_gemini_api_key')) return true;
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
        () => cancelGeneration.current,
        settings.apiKey,
        settings.cloudVoice
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
    stopAllPlayback();
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
            <strong>Auralis</strong>
            <small>Livre audio IA & Résumés</small>
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
            <strong>{selectedBook?.title ?? 'Auralis'}</strong>
            <span>
              {selectedBook
                ? 'Bibliothèque locale'
                : 'Convertisseur PDF → livre audio'}
            </span>
          </div>
          <div className="lv-top-actions">
            {settings.apiKey?.trim() ? (
              <span
                style={{
                  fontSize: '11px',
                  color: '#4ade80',
                  background: 'rgba(34, 197, 94, 0.12)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  padding: '4px 9px',
                  borderRadius: '20px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontWeight: 500,
                }}
                title="Vos identifiants API sont chargés et actifs"
              >
                <CheckCircle2 size={12} />
                <span>API {settings.ttsProvider || 'gemini'} connectée</span>
              </span>
            ) : null}
            <button
              className="lv-icon-button"
              title="Synchroniser avec GitHub"
              onClick={() => setGithubModalOpen(true)}
            >
              <GitBranch size={17} />
            </button>
            <a
              href="/api/download-zip"
              download="Auralis-LivreVox-code.zip"
              className="lv-icon-button"
              title="Télécharger tout le code source (.zip)"
              style={{ textDecoration: 'none' }}
            >
              <Download size={17} />
            </a>
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

              {/* Bannière de reprise automatique */}
              {resumeState && !audioPlaying && (
                <div className="lv-resume-banner">
                  <div className="lv-resume-info">
                    <div className="lv-resume-icon">
                      <Headphones size={20} />
                    </div>
                    <div className="lv-resume-text">
                      <strong>Reprendre votre écoute : {resumeState.chapterTitle}</strong>
                      <span>
                        {resumeState.bookTitle} · {formatTime(resumeState.currentTime)} / {formatTime(resumeState.duration)}
                      </span>
                    </div>
                  </div>
                  <div className="lv-resume-actions">
                    <button
                      className="lv-primary"
                      onClick={handleResume}
                      style={{ width: 'auto', padding: '7px 14px', fontSize: '13px' }}
                    >
                      <Play size={14} fill="currentColor" /> Reprendre
                    </button>
                    <button
                      className="lv-ghost"
                      onClick={() => {
                        setResumeState(null);
                        localStorage.removeItem('auralis_resume_state');
                      }}
                      title="Ignorer"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}

              <nav className="lv-tabs" aria-label="Sections du livre">
                <button
                  className={`lv-tab ${tab === 'listen' ? 'active' : ''}`}
                  onClick={() => setTab('listen')}
                >
                  <Headphones size={15} /> Écouter
                </button>
                <button
                  className={`lv-tab ${tab === 'chapters' ? 'active' : ''}`}
                  onClick={() => setTab('chapters')}
                >
                  <BookOpen size={15} /> Chapitres
                </button>
                <button
                  className={`lv-tab ${tab === 'summary' ? 'active' : ''}`}
                  onClick={() => setTab('summary')}
                >
                  <Brain size={15} /> Résumé IA
                </button>
                <button
                  className={`lv-tab ${tab === 'export' ? 'active' : ''}`}
                  onClick={() => setTab('export')}
                >
                  <Sparkles size={15} /> Générer & exporter
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
                            {selectedChapter.words.toLocaleString('fr-FR')} mots · environ{' '}
                            {selectedChapter.estimatedMinutes} min
                          </p>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span className={`lv-player-mode-tag ${playableAudioUrl ? '' : 'instant'}`}>
                            <Volume2 size={12} />
                            {playableAudioUrl ? 'Audio HD généré' : 'Voix système directe'}
                          </span>
                          <button
                            className="lv-icon-button"
                            title="Mode lecteur immersif plein écran"
                            onClick={() => setIsImmersiveOpen(true)}
                          >
                            <Maximize2 size={16} />
                          </button>
                        </div>
                      </div>
                      <div className="lv-text">
                        {paragraphs.map((para, idx) => (
                          <p
                            key={idx}
                            className={`lv-paragraph-item ${idx === activeParagraphIndex && (audioPlaying || speechState === 'playing') ? 'active' : ''}`}
                            onClick={() => {
                              if (playableAudioUrl && audioDuration > 0 && audioRef.current) {
                                const targetSec = (idx / paragraphs.length) * audioDuration;
                                seekTo(targetSec);
                                if (!audioPlaying) void audioRef.current.play().catch(() => undefined);
                              }
                            }}
                          >
                            {para}
                          </p>
                        ))}
                      </div>
                    </article>

                    {/* Lecteur Audio Intégré Haute Performance */}
                    <div className="lv-player-card">
                      <div className="lv-player-header">
                        <div className="lv-player-track-info">
                          <div className="lv-player-cover">
                            {audioPlaying || speechState === 'playing' ? (
                              <div className="lv-eq-bars">
                                <span className="lv-eq-bar" />
                                <span className="lv-eq-bar" />
                                <span className="lv-eq-bar" />
                                <span className="lv-eq-bar" />
                              </div>
                            ) : (
                              <Headphones size={20} />
                            )}
                          </div>
                          <div className="lv-player-titles">
                            <strong>{selectedChapter.title}</strong>
                            <small>{selectedBook.title}</small>
                          </div>
                        </div>

                        <div className="lv-player-actions-cluster">
                          <button
                            className="lv-icon-button"
                            title="Mode immersif plein écran"
                            onClick={() => setIsImmersiveOpen(true)}
                          >
                            <Maximize2 size={16} />
                          </button>
                        </div>
                      </div>

                      {/* Scrubber Timeline */}
                      <div className="lv-scrubber-container">
                        <span className="lv-time-display">
                          {playableAudioUrl
                            ? formatTime(audioCurrentTime)
                            : speechProgress > 0
                              ? `${speechProgress}%`
                              : '0:00'}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={playableAudioUrl ? (audioDuration || 1) : 100}
                          step={playableAudioUrl ? 0.5 : 1}
                          value={playableAudioUrl ? audioCurrentTime : speechProgress}
                          onChange={e => {
                            if (playableAudioUrl) {
                              seekTo(Number(e.target.value));
                            }
                          }}
                          disabled={!playableAudioUrl}
                          className="lv-scrubber-slider"
                          aria-label="Position de lecture"
                        />
                        <span className="lv-time-display lv-time-right">
                          {playableAudioUrl
                            ? formatTime(audioDuration || selectedChapter.estimatedMinutes * 60)
                            : `~${selectedChapter.estimatedMinutes}m`}
                        </span>
                      </div>

                      {/* Transport Controls Row */}
                      <div className="lv-player-controls-row">
                        <button
                          className="lv-ctrl-btn"
                          title="Chapitre précédent"
                          disabled={selectedBook.chapters.findIndex(c => c.id === selectedChapter.id) === 0}
                          onClick={goToPrevChapter}
                          aria-label="Chapitre précédent"
                        >
                          <SkipBack size={17} />
                        </button>

                        <button
                          className="lv-ctrl-btn"
                          title="Reculer de 15 secondes"
                          onClick={() => handleSkip(-15)}
                          aria-label="Reculer de 15 secondes"
                        >
                          <RotateCcw size={16} />
                          <span className="lv-skip-label">15</span>
                        </button>

                        <button
                          className="lv-ctrl-btn-play"
                          title={audioPlaying || speechState === 'playing' ? 'Mettre en pause' : 'Lire l’audio'}
                          onClick={togglePlayPause}
                          aria-label={audioPlaying || speechState === 'playing' ? 'Mettre en pause' : 'Lire'}
                        >
                          {audioPlaying || speechState === 'playing' ? (
                            <Pause size={24} fill="currentColor" />
                          ) : (
                            <Play size={24} fill="currentColor" style={{ marginLeft: '2px' }} />
                          )}
                        </button>

                        <button
                          className="lv-ctrl-btn"
                          title="Avancer de 15 secondes"
                          onClick={() => handleSkip(15)}
                          aria-label="Avancer de 15 secondes"
                        >
                          <RotateCw size={16} />
                          <span className="lv-skip-label">15</span>
                        </button>

                        <button
                          className="lv-ctrl-btn"
                          title="Chapitre suivant"
                          disabled={
                            selectedBook.chapters.findIndex(c => c.id === selectedChapter.id) ===
                            selectedBook.chapters.length - 1
                          }
                          onClick={() => goToNextChapter(false)}
                          aria-label="Chapitre suivant"
                        >
                          <SkipForward size={17} />
                        </button>
                      </div>

                      {/* Footer Controls: Vitesse, Minuterie, Mode */}
                      <div className="lv-player-footer-tools">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <select
                            aria-label="Vitesse de lecture"
                            className="lv-rate"
                            value={settings.rate}
                            onChange={event => updateRate(Number(event.target.value))}
                          >
                            {SPEEDS.map(rate => (
                              <option key={rate} value={rate}>
                                {rate}×
                              </option>
                            ))}
                          </select>

                          <button
                            type="button"
                            className="lv-icon-button"
                            style={{ height: '32px', padding: '0 8px', fontSize: '12px', width: 'auto', gap: '4px' }}
                            onClick={() => setTab('summary')}
                            title="Ouvrir le Résumé IA de ce chapitre"
                          >
                            <Brain size={13} />
                            <span>Résumé IA</span>
                          </button>

                          <button
                            type="button"
                            className="lv-icon-button"
                            style={{ height: '32px', padding: '0 8px', fontSize: '12px', width: 'auto', gap: '4px' }}
                            onClick={toggleInstantSpeech}
                            title="Synthèse vocale système instantanée (sans génération)"
                          >
                            <Volume2 size={13} />
                            <span>{speechState === 'playing' ? 'Pause directe' : 'Voix directe'}</span>
                          </button>

                          <select
                            aria-label="Minuterie de veille"
                            className="lv-rate"
                            value={sleepTimerMinutes ?? ''}
                            onChange={e => {
                              const val = e.target.value ? Number(e.target.value) : null;
                              setSleepTimerMinutes(val);
                              if (val) {
                                showToast(`Minuterie : arrêt automatique dans ${val} min.`);
                              } else {
                                showToast('Minuterie de veille désactivée.');
                              }
                            }}
                          >
                            <option value="">Veille : off</option>
                            <option value="15">Arrêt 15 min</option>
                            <option value="30">Arrêt 30 min</option>
                            <option value="45">Arrêt 45 min</option>
                            <option value="60">Arrêt 60 min</option>
                          </select>
                        </div>

                        {sleepRemainingSeconds !== null && (
                          <span className="lv-player-mode-tag" style={{ color: '#fbbf24', borderColor: 'rgba(251, 191, 36, 0.4)' }}>
                            <Moon size={12} /> {formatTime(sleepRemainingSeconds)}
                          </span>
                        )}

                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#94a3b8', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={autoPlayNext}
                            onChange={e => setAutoPlayNext(e.target.checked)}
                          />
                          Enchaîner auto
                        </label>
                      </div>
                    </div>

                    <audio
                      ref={audioRef}
                      src={playableAudioUrl || undefined}
                      style={{ display: 'none' }}
                      onTimeUpdate={() => {
                        if (audioRef.current) {
                          setAudioCurrentTime(audioRef.current.currentTime);
                          setAudioDuration(audioRef.current.duration || 0);
                        }
                      }}
                      onLoadedMetadata={() => {
                        if (audioRef.current) {
                          setAudioDuration(audioRef.current.duration || 0);
                          audioRef.current.playbackRate = settings.rate;
                        }
                      }}
                      onPlay={() => {
                        setAudioPlaying(true);
                        window.speechSynthesis?.cancel();
                        setSpeechState('idle');
                      }}
                      onPause={() => {
                        setAudioPlaying(false);
                      }}
                      onEnded={() => {
                        setAudioPlaying(false);
                        if (autoPlayNext) {
                          goToNextChapter(true);
                        }
                      }}
                    />
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
                        <button
                          className="lv-ghost"
                          onClick={() => {
                            setChapterId(chapter.id);
                            setTab('summary');
                          }}
                          title="Consulter le résumé IA de cette section"
                        >
                          <Brain size={13} /> Résumé IA
                        </button>
                        <button
                          className="lv-ghost lv-danger"
                          onClick={() => setDeleteChapterTarget(chapter)}
                          title="Supprimer cette section/chapitre du livre"
                        >
                          <Trash2 size={13} /> Supprimer
                        </button>
                        {audioMap[chapter.id] && !chapter.audioUrl && (
                          <button
                            className="lv-ghost lv-danger"
                            onClick={() => void removeGeneratedChapter(chapter)}
                            title="Supprimer uniquement l’audio généré"
                          >
                            <Trash2 size={13} /> Audio
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {tab === 'summary' && selectedChapter && (
                <section className="lv-summary-panel">
                  <div className="lv-summary-hero">
                    <div className="lv-summary-hero-copy">
                      <h2>
                        <Brain size={20} /> Résumé & Mémorisation IA — {selectedChapter.title}
                      </h2>
                      <p>
                        Synthèse intelligente propulsée par IA : points clés, concepts, anti-spoiler et format optimisé pour l'écoute.
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                      {selectedChapter.summary && (
                        <button
                          className="lv-secondary"
                          onClick={() => void playSummaryWithIA(selectedChapter.summary!)}
                          disabled={summaryLoading}
                          title="Écouter la synthèse vocale IA de ce résumé"
                        >
                          <Volume2 size={14} /> Écouter le résumé (IA)
                        </button>
                      )}
                      <button
                        className="lv-primary"
                        style={{ width: 'auto' }}
                        onClick={() => void generateChapterSummary(selectedChapter)}
                        disabled={summaryLoading}
                      >
                        {summaryLoading ? (
                          <>
                            <RefreshCw size={14} className="animate-spin" /> Analyse IA en cours...
                          </>
                        ) : selectedChapter.summary ? (
                          <>
                            <RotateCcw size={14} /> Régénérer le résumé
                          </>
                        ) : (
                          <>
                            <Sparkles size={14} /> Générer le résumé de ce chapitre
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Sélecteur rapide de chapitre pour le résumé */}
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px' }}>
                    {selectedBook.chapters.map((ch, idx) => (
                      <button
                        key={ch.id}
                        className={`lv-tab ${ch.id === selectedChapter.id ? 'active' : ''}`}
                        style={{ padding: '6px 12px', fontSize: '12px', whiteSpace: 'nowrap' }}
                        onClick={() => setChapterId(ch.id)}
                      >
                        Ch. {idx + 1} : {ch.title.length > 25 ? `${ch.title.slice(0, 25)}…` : ch.title} {ch.summary ? '✓' : ''}
                      </button>
                    ))}
                  </div>

                  <div className="lv-summary-content">
                    {selectedChapter.summary ? (
                      renderFormattedSummary(selectedChapter.summary)
                    ) : (
                      <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8' }}>
                        <Brain size={48} style={{ margin: '0 auto 16px', opacity: 0.5, color: '#a78bfa' }} />
                        <h3 style={{ color: '#f8fafc', fontSize: '18px', marginBottom: '8px' }}>
                          Aucun résumé pour « {selectedChapter.title} » pour le moment
                        </h3>
                        <p style={{ maxWidth: '520px', margin: '0 auto 20px', fontSize: '13px', lineHeight: 1.6 }}>
                          Cliquez sur « Générer le résumé de ce chapitre » pour obtenir une analyse structurée en 6 sections : ⚡ Le chapitre en 30 secondes, 📖 Résumé détaillé, 🧠 À retenir, 👥 Personnages ou 💡 Concepts importants, 🔗 Pourquoi ce chapitre est important, et 🎯 Si tu ne devais retenir qu’une seule chose.
                        </p>
                        <button
                          className="lv-primary"
                          style={{ width: 'auto', margin: '0 auto' }}
                          onClick={() => void generateChapterSummary(selectedChapter)}
                          disabled={summaryLoading}
                        >
                          <Sparkles size={15} /> {summaryLoading ? 'Analyse IA...' : 'Générer avec IA'}
                        </button>
                      </div>
                    )}
                  </div>
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

                  {/* Export du Code Source Complet */}
                  <div className="lv-card" style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                      <strong style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Download size={16} style={{ color: '#818cf8' }} /> Code Source Complet du Projet (.zip)
                      </strong>
                      <span style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginTop: '3px' }}>
                        Téléchargez l'archive complète du projet (40 fichiers : React/Vite, Serveur Express, TTS, CI GitHub, styles).
                      </span>
                    </div>
                    <a
                      href="/api/download-zip"
                      download="Auralis-LivreVox-code.zip"
                      className="lv-primary"
                      style={{ width: 'auto', textDecoration: 'none', padding: '10px 18px', fontSize: '13px' }}
                    >
                      <Download size={15} /> Télécharger le ZIP (20 Mo)
                    </a>
                  </div>
                </section>
              )}
              {/* Espacement de sécurité pour ne jamais masquer les boutons ou le texte */}
              <div style={{ height: '80px', minHeight: '80px' }} />
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
            <p>Personnalise les voix de lecture selon tes préférences.</p>

            <div className="lv-field">
              <label htmlFor="cloud-voice">Voix Cloud (selon le fournisseur)</label>
              <select
                id="cloud-voice"
                className="lv-select"
                value={settings.cloudVoice || 'Kore'}
                onChange={event =>
                  setSettings(current => ({
                    ...current,
                    cloudVoice: event.target.value,
                  }))
                }
              >
                {CLOUD_VOICES.map(voice => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </select>
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>
                Voix utilisées lors de la génération de fichiers audio haute fidélité via l’IA.
              </p>
            </div>

            <div className="lv-field">
              <label htmlFor="neural-voice">Voix locale Piper (Secours & Hors-ligne)</label>
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
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>
                {storedVoices.includes(settings.voiceId)
                  ? '✓ Cette voix locale est enregistrée dans votre navigateur.'
                  : 'Téléchargée automatiquement lors de la première génération locale.'}
              </p>
            </div>

            <div className="lv-field">
              <label htmlFor="system-voice">
                Voix système (Pour le bouton « Écouter » instantané)
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  id="system-voice"
                  className="lv-select"
                  style={{ flex: 1 }}
                  value={settings.systemVoiceUri}
                  onChange={event =>
                    setSettings(current => ({
                      ...current,
                      systemVoiceUri: event.target.value,
                    }))
                  }
                >
                  <option value="">Automatique (meilleure voix française)</option>
                  {frenchSystemVoices.map(voice => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.name} ({voice.lang})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="lv-secondary"
                  style={{ width: 'auto', whiteSpace: 'nowrap' }}
                  onClick={() => {
                    if (!('speechSynthesis' in window)) return;
                    window.speechSynthesis.cancel();
                    const utt = new SpeechSynthesisUtterance('Bonjour ! Ceci est un aperçu de la voix pour votre livre audio.');
                    utt.rate = settings.rate;
                    const v = systemVoices.find(item => item.voiceURI === settings.systemVoiceUri) ||
                              systemVoices.find(item => item.lang.toLowerCase().startsWith('fr'));
                    if (v) utt.voice = v;
                    window.speechSynthesis.speak(utt);
                  }}
                >
                  Tester
                </button>
              </div>
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
            <div className="lv-field">
              <label htmlFor="tts-provider">Fournisseur IA</label>
              <select
                id="tts-provider"
                className="lv-select"
                value={settings.ttsProvider || 'gemini'}
                onChange={event => {
                  const provider = event.target.value as AppSettings['ttsProvider'];
                  setSettings(current => ({ ...current, ttsProvider: provider }));
                  setKeyTestStatus('idle');
                  setKeyTestError(null);
                }}
              >
                <option value="deepinfra">DeepInfra · Kokoro (économique)</option>
                <option value="gemini">Google IA</option>
                <option value="aws-polly">Amazon Polly</option>
              </select>
            </div>

            <div className="lv-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="provider-key">
                  {(settings.ttsProvider || 'gemini') === 'aws-polly' ? 'AWS Access Key ID' : 'Clé API'}
                </label>
                {settings.apiKey?.trim() ? (
                  <span style={{ fontSize: '11px', color: '#4ade80', display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 500 }}>
                    <CheckCircle2 size={12} /> Enregistrée
                  </span>
                ) : null}
              </div>
              <input
                id="provider-key"
                type="password"
                className="lv-input"
                placeholder={(settings.ttsProvider || 'gemini') === 'deepinfra' ? 'Clé DeepInfra' : (settings.ttsProvider || 'gemini') === 'aws-polly' ? 'AKIA...' : 'AIzaSy...'}
                value={settings.apiKey || ''}
                onChange={event => {
                  setSettings(current => ({ ...current, apiKey: event.target.value.trim() }));
                  setKeyTestStatus('idle');
                  setKeyTestError(null);
                }}
              />
              {(settings.ttsProvider || 'gemini') === 'aws-polly' && (
                <>
                  <input
                    type="password"
                    className="lv-input"
                    style={{ marginTop: 8 }}
                    placeholder="AWS Secret Access Key"
                    value={settings.apiSecret || ''}
                    onChange={event => setSettings(current => ({ ...current, apiSecret: event.target.value.trim() }))}
                  />
                  <input
                    className="lv-input"
                    style={{ marginTop: 8 }}
                    placeholder="Région AWS (ex. eu-west-3)"
                    value={settings.awsRegion || 'eu-west-3'}
                    onChange={event => setSettings(current => ({ ...current, awsRegion: event.target.value.trim() }))}
                  />
                </>
              )}
              <button
                type="button"
                className="lv-secondary"
                style={{ width: 'auto', whiteSpace: 'nowrap', marginTop: 8 }}
                onClick={() => void testApiKey()}
                disabled={!settings.apiKey?.trim() || keyTestStatus === 'testing' || ((settings.ttsProvider || 'gemini') === 'aws-polly' && !settings.apiSecret?.trim())}
              >
                {keyTestStatus === 'testing' ? 'Test...' : 'Tester la connexion'}
              </button>

              {keyTestStatus === 'valid' && (
                <p style={{ fontSize: '0.8rem', color: '#4ade80', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={13} /> Connexion API validée.
                </p>
              )}
              {keyTestStatus === 'invalid' && (
                <p style={{ fontSize: '0.8rem', color: '#f87171', marginTop: 4 }}>
                  ✕ {keyTestError || 'Identifiants API invalides.'}
                </p>
              )}
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>
                Les identifiants sont conservés dans ce navigateur et envoyés uniquement au backend LivreVox pour appeler le fournisseur choisi.
              </p>
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
              « {deleteTarget.title} » et ses fichiers audio seront supprimés {deleteTarget.cloudJobId ? 'de cet appareil et du stockage cloud Auralis' : 'du stockage local de cet appareil'}.
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

      {deleteChapterTarget && (
        <div className="lv-modal-wrap">
          <div className="lv-card lv-modal">
            <h2>Supprimer cette section / chapitre ?</h2>
            <p>
              Êtes-vous sûr de vouloir supprimer définitivement la section « {deleteChapterTarget.title} » de « {selectedBook?.title} » ?
            </p>
            <div className="lv-modal-actions">
              <button
                className="lv-ghost"
                onClick={() => setDeleteChapterTarget(null)}
              >
                Annuler
              </button>
              <button
                className="lv-secondary lv-danger"
                onClick={() => void confirmDeleteChapter()}
              >
                <Trash2 size={13} /> Supprimer la section
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale de synchronisation GitHub */}
      {githubModalOpen && (
        <div
          className="lv-modal-wrap"
          onMouseDown={e => {
            if (e.target === e.currentTarget) setGithubModalOpen(false);
          }}
        >
          <div className="lv-card lv-modal" style={{ maxWidth: '520px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <GitBranch size={20} style={{ color: '#a78bfa' }} />
                <h2>Synchronisation GitHub</h2>
              </div>
              <button className="lv-icon-button" onClick={() => setGithubModalOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <p style={{ marginTop: '8px', fontSize: '13px', color: '#94a3b8' }}>
              Pousse automatiquement l'intégralité du code et le commit en cours vers votre dépôt distant GitHub sur la branche <strong>main</strong>.
            </p>

            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #1e293b', borderRadius: '10px', padding: '12px', marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
                <span style={{ color: '#94a3b8' }}>Dépôt cible :</span>
                <a
                  href="https://github.com/nathsrb/LivreVox"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#818cf8', display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none' }}
                >
                  nathsrb/LivreVox <ExternalLink size={11} />
                </a>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <span style={{ color: '#94a3b8' }}>Branche :</span>
                <span style={{ color: '#4ade80', fontWeight: 600 }}>main (commit prêt)</span>
              </div>
            </div>

            <div className="lv-field" style={{ marginTop: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="gh-token" style={{ fontSize: '13px', fontWeight: 600 }}>
                  Personal Access Token GitHub (PAT)
                </label>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=Auralis-LivreVox"
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: '11px', color: '#a78bfa', display: 'inline-flex', alignItems: 'center', gap: '3px', textDecoration: 'none' }}
                >
                  Créer un jeton (scope repo) <ExternalLink size={10} />
                </a>
              </div>
              <input
                id="gh-token"
                type="password"
                className="lv-input"
                placeholder="ghp_... ou github_pat_..."
                value={githubToken}
                onChange={e => setGithubToken(e.target.value)}
                autoFocus
              />
              <p style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                Requis par GitHub pour autoriser l'écriture sur votre compte <strong>nathsrb</strong>. Ce jeton est stocké uniquement localement dans votre navigateur.
              </p>
            </div>

            {githubSyncResult && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: '10px',
                  fontSize: '12px',
                  marginTop: '10px',
                  background: githubSyncResult.ok ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                  border: `1px solid ${githubSyncResult.ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                  color: githubSyncResult.ok ? '#4ade80' : '#f87171',
                }}
              >
                {githubSyncResult.message}
              </div>
            )}

            <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ fontSize: '13px', color: '#93c5fd', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Download size={14} /> Alternative : Télécharger le code (.zip)
                </strong>
                <span style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginTop: '2px' }}>
                  Archive autonome complète (40 fichiers source prêts à être extraits).
                </span>
              </div>
              <a
                href="/api/download-zip"
                download="Auralis-LivreVox-code.zip"
                className="lv-secondary"
                style={{ textDecoration: 'none', fontSize: '12px', padding: '6px 12px', whiteSpace: 'nowrap' }}
              >
                Télécharger .zip
              </a>
            </div>

            <div className="lv-modal-actions" style={{ marginTop: '18px' }}>
              <button className="lv-ghost" onClick={() => setGithubModalOpen(false)}>
                Fermer
              </button>
              <button
                className="lv-primary"
                style={{ width: 'auto' }}
                disabled={githubSyncing || !githubToken.trim()}
                onClick={() => void handleGithubPush()}
              >
                {githubSyncing ? (
                  <>
                    <RefreshCw size={14} className="lv-spin" /> Synchronisation en cours...
                  </>
                ) : (
                  <>
                    <GitBranch size={14} /> Pousser vers GitHub (main)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Barre de lecture fixe en bas d'écran (Sticky Docked Player) uniquement hors onglet lecteur */}
      {selectedBook && selectedChapter && tab !== 'listen' && (playableAudioUrl || audioPlaying || speechState === 'playing') && !dockedDismissed && (
        <div className="lv-docked-player">
          <div className="lv-docked-left">
            <div className="lv-player-cover" style={{ width: '38px', height: '38px', borderRadius: '10px' }}>
              {audioPlaying || speechState === 'playing' ? (
                <div className="lv-eq-bars" style={{ height: '12px' }}>
                  <span className="lv-eq-bar" />
                  <span className="lv-eq-bar" />
                  <span className="lv-eq-bar" />
                </div>
              ) : (
                <Headphones size={18} />
              )}
            </div>
            <div className="lv-player-titles">
              <strong style={{ fontSize: '13px' }}>{selectedChapter.title}</strong>
              <small>{selectedBook.title}</small>
            </div>
          </div>

          <div className="lv-docked-center">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button className="lv-ctrl-btn" style={{ width: '32px', height: '32px' }} onClick={goToPrevChapter} title="Chapitre précédent">
                <SkipBack size={14} />
              </button>
              <button className="lv-ctrl-btn" style={{ width: '32px', height: '32px' }} onClick={() => handleSkip(-15)} title="-15s">
                <RotateCcw size={13} />
              </button>
              <button className="lv-ctrl-btn-play" style={{ width: '40px', height: '40px' }} onClick={togglePlayPause} title={audioPlaying || speechState === 'playing' ? 'Pause' : 'Lecture'}>
                {audioPlaying || speechState === 'playing' ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: '2px' }} />}
              </button>
              <button className="lv-ctrl-btn" style={{ width: '32px', height: '32px' }} onClick={() => handleSkip(15)} title="+15s">
                <RotateCw size={13} />
              </button>
              <button className="lv-ctrl-btn" style={{ width: '32px', height: '32px' }} onClick={() => goToNextChapter(false)} title="Chapitre suivant">
                <SkipForward size={14} />
              </button>
            </div>
          </div>

          <div className="lv-docked-right">
            <span className="lv-time-display" style={{ fontSize: '11px' }}>
              {playableAudioUrl ? `${formatTime(audioCurrentTime)} / ${formatTime(audioDuration || selectedChapter.estimatedMinutes * 60)}` : `${speechProgress}%`}
            </span>
            <button className="lv-icon-button" title="Ouvrir le lecteur complet" onClick={() => setTab('listen')}>
              <Headphones size={15} />
            </button>
            <button className="lv-icon-button" title="Agrandir en mode plein écran immersif" onClick={() => setIsImmersiveOpen(true)}>
              <Maximize2 size={15} />
            </button>
            <button className="lv-icon-button" title="Masquer la barre d’écoute" onClick={() => setDockedDismissed(true)}>
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Lecteur Plein Écran Immersif (Mode Podcast / Salon) */}
      {isImmersiveOpen && selectedBook && selectedChapter && (
        <div className="lv-immersive-overlay">
          <div className="lv-immersive-topbar">
            <button className="lv-secondary" onClick={() => setIsImmersiveOpen(false)}>
              <Minimize2 size={16} /> Fermer
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className={`lv-player-mode-tag ${playableAudioUrl ? '' : 'instant'}`}>
                <Volume2 size={13} /> {playableAudioUrl ? 'Audio HD' : 'Voix système directe'}
              </span>
              {sleepRemainingSeconds !== null && (
                <span className="lv-player-mode-tag" style={{ color: '#fbbf24', borderColor: 'rgba(251, 191, 36, 0.4)' }}>
                  <Moon size={12} /> {formatTime(sleepRemainingSeconds)}
                </span>
              )}
            </div>
          </div>

          <div className="lv-immersive-body">
            <div className="lv-immersive-artwork">
              <div className="lv-immersive-artwork-glow" />
              {audioPlaying || speechState === 'playing' ? (
                <div className="lv-eq-bars" style={{ height: '40px', gap: '8px' }}>
                  <span className="lv-eq-bar" style={{ width: '6px' }} />
                  <span className="lv-eq-bar" style={{ width: '6px' }} />
                  <span className="lv-eq-bar" style={{ width: '6px' }} />
                  <span className="lv-eq-bar" style={{ width: '6px' }} />
                  <span className="lv-eq-bar" style={{ width: '6px' }} />
                </div>
              ) : (
                <Headphones size={72} />
              )}
            </div>

            <div className="lv-immersive-meta">
              <h2>{selectedChapter.title}</h2>
              <p>{selectedBook.title} · {selectedChapter.words.toLocaleString('fr-FR')} mots</p>
            </div>

            <div className="lv-immersive-controls">
              <div className="lv-scrubber-container">
                <span className="lv-time-display">{playableAudioUrl ? formatTime(audioCurrentTime) : `${speechProgress}%`}</span>
                <input
                  type="range"
                  min={0}
                  max={playableAudioUrl ? (audioDuration || 1) : 100}
                  step={playableAudioUrl ? 0.5 : 1}
                  value={playableAudioUrl ? audioCurrentTime : speechProgress}
                  onChange={e => {
                    if (playableAudioUrl) seekTo(Number(e.target.value));
                  }}
                  disabled={!playableAudioUrl}
                  className="lv-scrubber-slider"
                />
                <span className="lv-time-display lv-time-right">
                  {playableAudioUrl ? formatTime(audioDuration || selectedChapter.estimatedMinutes * 60) : `~${selectedChapter.estimatedMinutes}m`}
                </span>
              </div>

              <div className="lv-player-controls-row" style={{ gap: '18px' }}>
                <button className="lv-ctrl-btn" style={{ width: '48px', height: '48px' }} onClick={goToPrevChapter} title="Précédent">
                  <SkipBack size={20} />
                </button>
                <button className="lv-ctrl-btn" style={{ width: '48px', height: '48px' }} onClick={() => handleSkip(-15)} title="-15s">
                  <RotateCcw size={18} />
                  <span className="lv-skip-label">15</span>
                </button>
                <button className="lv-ctrl-btn-play" style={{ width: '68px', height: '68px' }} onClick={togglePlayPause}>
                  {audioPlaying || speechState === 'playing' ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" style={{ marginLeft: '3px' }} />}
                </button>
                <button className="lv-ctrl-btn" style={{ width: '48px', height: '48px' }} onClick={() => handleSkip(15)} title="+15s">
                  <RotateCw size={18} />
                  <span className="lv-skip-label">15</span>
                </button>
                <button className="lv-ctrl-btn" style={{ width: '48px', height: '48px' }} onClick={() => goToNextChapter(false)} title="Suivant">
                  <SkipForward size={20} />
                </button>
              </div>
            </div>

            <div className="lv-immersive-reader">
              {paragraphs.map((para, idx) => (
                <p
                  key={idx}
                  className={`lv-paragraph-item ${idx === activeParagraphIndex && (audioPlaying || speechState === 'playing') ? 'active' : ''}`}
                  onClick={() => {
                    if (playableAudioUrl && audioDuration > 0 && audioRef.current) {
                      const targetSec = (idx / paragraphs.length) * audioDuration;
                      seekTo(targetSec);
                      if (!audioPlaying) void audioRef.current.play().catch(() => undefined);
                    }
                  }}
                >
                  {para}
                </p>
              ))}
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
