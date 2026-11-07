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
  clearSpeechSegments,
  clearSummarySegments,
  countSavedAudioSegments,
  deleteAudio,
  deleteBook,
  getBookAudio,
  getBooks,
  getSummarySegments,
  saveSummarySegment,
  putAudio,
  putBook,
} from './lib/storage';
import {
  CLOUD_VOICES,
  getGeminiVoices,
  setPreferredSpeechRoute,
  type SpeechRoute,
  makeBookZip,
  synthesizeChapter,
  type GeminiVoiceOption,
} from './lib/tts';

const KOKORO_VOICES: GeminiVoiceOption[] = [
  { id: 'ff_siwis', label: 'Siwis · Français', displayName: 'Siwis' },
];

const DEFAULT_SETTINGS: AppSettings = {
  rate: 1,
  cloudVoice: 'ff_siwis',
  ttsProvider: 'deepinfra',
  apiKey: '',
  apiSecret: '',
  awsRegion: 'eu-west-3',
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

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function loadSettings(): AppSettings {
  try {
    const rawA = localStorage.getItem('auralis-settings');
    const rawL = localStorage.getItem('livrevox-settings');
    const parsedA = rawA ? (JSON.parse(rawA) as Partial<AppSettings>) : {};
    const parsedL = rawL ? (JSON.parse(rawL) as Partial<AppSettings>) : {};
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...parsedL, ...parsedA };
    const savedRate = localStorage.getItem('auralis_playback_rate');
    if (savedRate && !isNaN(Number(savedRate))) merged.rate = Number(savedRate);
    // Kokoro/DeepInfra is the only speech-generation provider in this preview.
    // Retain an existing DeepInfra key, but do not reuse a legacy Google key.
    if (merged.ttsProvider !== 'deepinfra') {
      merged.ttsProvider = 'deepinfra';
      merged.cloudVoice = 'ff_siwis';
      merged.apiKey = '';
    }
    if (merged.cloudVoice !== 'ff_siwis') merged.cloudVoice = 'ff_siwis';
    // Don't persist obsolete local voice identifiers from older app versions.
    delete (merged as unknown as Record<string, unknown>).voiceId;
    delete (merged as unknown as Record<string, unknown>).systemVoiceUri;
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function renderFormattedSummary(text: string) {
  const sections = text.split(/(?=^###\s)/gm).map(part => part.trim()).filter(Boolean);
  return (
    <div className="lv-summary-sections">
      {sections.map((section, index) => {
        const [heading, ...lines] = section.split('\n');
        const title = heading.replace(/^###\s*/, '').trim();
        const blocks = lines.join('\n').trim().split(/\n\s*\n/).filter(Boolean);
        return <section className="lv-summary-section" key={index}>
          <h3>{title}</h3>
          <div className="lv-summary-prose">
            {blocks.map((block, p) => {
              const rows = block.split('\n').filter(Boolean);
              const list = rows.every(line => /^\s*(?:[-*]\s+|\d+[.)]\s+)/.test(line));
              if (list) {
                const ordered = rows.every(line => /^\s*\d+[.)]\s+/.test(line));
                const entries = rows.map((line, j) => <li key={j}>{line.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, '').replace(/\*\*/g, '')}</li>);
                return ordered ? <ol key={p}>{entries}</ol> : <ul key={p}>{entries}</ul>;
              }
              return <p key={p}>{block.replace(/\*\*/g, '')}</p>;
            })}
          </div>
        </section>;
      })}
    </div>
  );
}

function isCloudGeneratedAudio(record: AudioRecord): boolean {
  return /^(gemini|deepinfra|aws-polly):/.test(record.voiceId || '');
}

function audioSourceLabel(voiceId?: string): string {
  return voiceId ? 'Voix de lecture' : 'Audio non disponible';
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
  ocrUsed: boolean,
  outlineChapters?: Array<{ title: string; text: string }>
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
    chapters: splitIntoChapters(cleanExtractedText(text), outlineChapters),
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
  const [cachedAudioPassages, setCachedAudioPassages] = useState<Record<string, number>>({});
  const [geminiVoices, setGeminiVoices] = useState<GeminiVoiceOption[]>(CLOUD_VOICES);
  const [generation, setGeneration] = useState<{
    active: boolean;
    progress: number;
    label: string;
    mode: 'chapter' | 'book';
  } | null>(null);
  const [renameChapter, setRenameChapter] = useState<Chapter | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [deleteChapterTarget, setDeleteChapterTarget] = useState<Chapter | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState('');
  const [savedSummaryWork, setSavedSummaryWork] = useState<{ chapterKey: string; count: number } | null>(null);
  const [keyTestStatus, setKeyTestStatus] = useState<'idle' | 'testing' | 'valid' | 'invalid'>('idle');
  const [keyTestError, setKeyTestError] = useState<string | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<{ fileName: string; incorrect: boolean } | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cancelGeneration = useRef(false);
  const lastVerifiedSpeech = useRef<{ expiresAt: number; route: SpeechRoute } | null>(null);
  const passwordResolver = useRef<((password: string | null) => void) | null>(null);

  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPartIndex, setAudioPartIndex] = useState(0);
  const pendingPartSeek = useRef<{ seconds: number; play: boolean } | null>(null);
  const pendingChapterResume = useRef<{ bookId: string; chapterId: string; seconds: number } | null>(null);
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

  const geminiVoiceOptions = useMemo(() => {
    const byId = new Map<string, GeminiVoiceOption>();
    for (const voice of CLOUD_VOICES) byId.set(voice.id, voice);
    for (const voice of geminiVoices) byId.set(voice.id, voice);
    const selected = (settings.cloudVoice || 'Kore').trim();
    if (selected && !byId.has(selected)) {
      byId.set(selected, {
        id: selected,
        label: selected,
        displayName: selected,
        description: 'Voix personnalisée',
        type: 'custom',
      });
    }
    return Array.from(byId.values());
  }, [geminiVoices, settings.cloudVoice]);

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
  const audioUrl = useMemo(() => {
    const part = currentAudio?.parts?.[audioPartIndex] || currentAudio?.blob;
    return part ? URL.createObjectURL(part) : '';
  }, [currentAudio, audioPartIndex]);
  const audioPartOffset = (currentAudio?.partDurations || [])
    .slice(0, audioPartIndex).reduce((total, seconds) => total + seconds, 0);
  const generatedCount = selectedBook
    ? selectedBook.chapters.filter(chapter => audioMap[chapter.id] || chapter.audioUrl).length
    : 0;
  const isCloudBook = Boolean(selectedBook?.cloudJobId);
  // Only recordings generated by cloud providers, or explicit remote cloud book URLs, may play.
  // No browser speechSynthesis / local Piper / local Kokoro TTS fallback.
  const playableAudioUrl = (isCloudBook && selectedChapter?.audioUrl) || audioUrl;
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
    const progress = playableAudioUrl && audioDuration > 0
      ? audioCurrentTime / audioDuration
      : 0;
    return Math.min(
      paragraphs.length - 1,
      Math.floor(progress * paragraphs.length)
    );
  }, [paragraphs.length, playableAudioUrl, audioDuration, audioCurrentTime]);

  // Recover completed local analysis work when the user returns to a chapter.
  // The generation itself cannot run while the browser page is unloaded.
  useEffect(() => {
    if (!selectedBook || !selectedChapter) {
      setSavedSummaryWork(null);
      return;
    }
    let cancelled = false;
    const chapterKey = selectedBook.id + ':' + selectedChapter.id;
    void getSummarySegments(selectedBook.id, selectedChapter.id).then(segments => {
      if (!cancelled) setSavedSummaryWork({ chapterKey, count: segments.length });
    }).catch(error => {
      console.warn('Auralis: unable to inspect saved summary progress', error);
      if (!cancelled) setSavedSummaryWork({ chapterKey, count: 0 });
    });
    return () => { cancelled = true; };
  }, [selectedBook?.id, selectedChapter?.id, summaryLoading]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await getBooks();
        // One-time cleanup of legacy computer-generated speech across the whole
        // library. Preserve cloud-generated recordings and PDF text.
        await Promise.allSettled(list.map(async book => {
          const oldRecords = await getBookAudio(book.id);
          const localOnly = oldRecords.filter(record => !isCloudGeneratedAudio(record));
          await Promise.all(localOnly.map(record => deleteAudio(record.bookId, record.chapterId)));
        }));
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

  // Show saved work on lengthy chapter audio even after browser reload.
  // This is a resume indicator, not a claim that a complete audio exists.
  useEffect(() => {
    if (!selectedBook) {
      setCachedAudioPassages({});
      return;
    }
    let cancelled = false;
    const book = selectedBook;
    void Promise.all(book.chapters.map(async chapter => ({
      id: chapter.id,
      count: await countSavedAudioSegments(book.id, chapter.id),
    }))).then(items => {
      if (!cancelled) setCachedAudioPassages(Object.fromEntries(items.map(item => [item.id, item.count])));
    }).catch(error => {
      console.warn('Auralis: unable to display saved audio progress', error);
    });
    return () => { cancelled = true; };
  }, [selectedBook?.id, generation?.active]);

  useEffect(() => {
    if (!selectedBook) {
      setAudioMap({});
      return;
    }
    if (!selectedBook.chapters.some(chapter => chapter.id === chapterId))
      setChapterId(selectedBook.chapters[0]?.id ?? '');
    void getBookAudio(selectedBook.id).then(async records => {
      const previousLocalAudio = records.filter(record => !isCloudGeneratedAudio(record));
      await Promise.all(previousLocalAudio.map(record => deleteAudio(record.bookId, record.chapterId))).catch(() => undefined);
      const allowed = records.filter(isCloudGeneratedAudio);
      setAudioMap(Object.fromEntries(allowed.map(record => [record.chapterId, record])));
    });
  }, [selectedBook?.id]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    // Selecting another chapter returns to the beginning of its own playlist.
    setAudioPartIndex(0);
    pendingPartSeek.current = null;
    setAudioCurrentTime(0);
  }, [selectedBook?.id, selectedChapter?.id, currentAudio?.createdAt]);

  useEffect(() => {
    void refreshGeminiVoiceData();
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
      const absoluteTime = audioPartOffset + (audioRef.current?.currentTime || 0);
      if (audioRef.current && absoluteTime > 2) {
        localStorage.setItem(
          'auralis_resume_state',
          JSON.stringify({
            bookId: selectedBook.id,
            chapterId: selectedChapter.id,
            currentTime: Math.floor(absoluteTime),
            duration: Math.floor(currentAudio?.duration || audioRef.current.duration || 0),
            rate: settings.rate,
            bookTitle: selectedBook.title,
            chapterTitle: selectedChapter.title,
            timestamp: Date.now(),
          })
        );
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [audioPlaying, selectedBook?.id, selectedChapter?.id, settings.rate, audioPartIndex, currentAudio?.duration]);

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
      // Preserve actionable details (remaining chunks and how to resume)
      // instead of replacing every quota error with a generic warning.
      cleanMessage = message.slice(0, 440);
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

  async function refreshGeminiVoiceData(): Promise<void> {
    if ((settings.ttsProvider || 'gemini') !== 'gemini') return;
    try {
      const voices = await getGeminiVoices(settings.apiKey);
      setGeminiVoices(voices);
    } catch {
      setGeminiVoices(CLOUD_VOICES);
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
    if (status.status === 'complete') showToast('Ton livre audio est prêt : tu peux écouter tous les chapitres.');
    else if (status.status === 'password_protected') showToast('PDF protégé détecté : Auralis repasse automatiquement en traitement local sécurisé.', true);
    else if (status.status === 'text_ready' && !status.ttsConfigured) showToast("Texte prêt. L'écoute n'est pas disponible pour le moment.");
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
    const book = buildBook(title, file.name, file.size, result.pages, cleaned, result.ocrUsed, result.outlineChapters);
    if (!book.chapters.length) throw new Error('Aucun chapitre exploitable n’a été détecté.');
    await putBook(book);
    setBooks(current => [book, ...current]);
    setSelectedId(book.id);
    setChapterId(book.chapters[0]?.id ?? '');

    // Import and narration must be separate. No paid API call occurs on upload.
    setTab('chapters');
    setImportProgress(null);
    showToast(book.chapters.length === 1 && book.chapters[0].title.includes('chapitres non détectés')
      ? 'PDF importé, mais son sommaire ne permet pas de repérer les chapitres d’origine. Le texte est conservé, sans créer de faux chapitres.'
      : `Livre importé : ${book.chapters.length} section${book.chapters.length > 1 ? 's' : ''}. Choisis la voix avant de générer de l’audio.`);

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
    showToast('Les premiers chapitres sont prêts, les autres sont en cours de préparation.');
    void continueCloudPipeline(jobId, file, book.id).catch(error => { setImportProgress(null); showToast(error instanceof Error ? error.message : 'La préparation du livre a été interrompue.', true); });
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

  function stopAllPlayback(): void {
    setAudioPartIndex(0);
    pendingPartSeek.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setAudioPlaying(false);
    setAudioCurrentTime(0);
  }

  function updateRate(newRate: number): void {
    setSettings(current => ({ ...current, rate: newRate }));
    localStorage.setItem('auralis_playback_rate', String(newRate));
    if (audioRef.current) audioRef.current.playbackRate = newRate;
  }

  function handleResume(): void {
    if (!resumeState) return;
    const targetBook = books.find(book => book.id === resumeState.bookId);
    if (!targetBook) {
      setResumeState(null);
      localStorage.removeItem('auralis_resume_state');
      return;
    }
    const targetChapter = targetBook.chapters.find(chapter => chapter.id === resumeState.chapterId) || targetBook.chapters[0];
    if (targetChapter) {
      pendingChapterResume.current = {
        bookId: targetBook.id, chapterId: targetChapter.id,
        seconds: resumeState.currentTime,
      };
      setSelectedId(targetBook.id);
      setChapterId(targetChapter.id);
      setTab('listen');
      // Already mounted audio may not emit another metadata event.
      window.setTimeout(() => {
        const pending = pendingChapterResume.current;
        if (pending && pending.bookId === targetBook.id && pending.chapterId === targetChapter.id &&
            audioRef.current && audioRef.current.readyState >= 1) {
          pendingChapterResume.current = null;
          seekTo(pending.seconds, true);
        }
      }, 350);
    }
    setResumeState(null);
    showToast('Reprise de « ' + resumeState.chapterTitle + ' »');
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

  function togglePlayPause(): void {
    if (playableAudioUrl && audioRef.current) {
      if (audioPlaying) {
        audioRef.current.pause();
      } else {
        void audioRef.current.play().catch(e => {
          console.error('Audio playback error:', e);
        });
      }
    } else {
      showToast('Pas encore d’audio pour ce chapitre. Choisis une voix avant de lancer la génération.');
      setTab('export');
    }
  }

  async function generateChapterSummary(chapter: Chapter): Promise<void> {
    if (!selectedBook || summaryLoading) return;
    const book = selectedBook;
    const resumed = chapter.summaryStatus === 'in_progress' || chapter.summaryStatus === 'interrupted';
    setSummaryLoading(true);
    setSummaryProgress(resumed ? 'Reprise des passages déjà sauvegardés…' : 'Lecture du chapitre…');
    try {
      // Persist a visible job marker immediately. Without it, closing/reloading
      // the tab before the first final section makes it appear as if nothing
      // was ever requested, despite completed local analysis segments.
      const markedBook: Book = {
        ...book,
        updatedAt: Date.now(),
        chapters: book.chapters.map(item => item.id === chapter.id
          ? {
              ...item, summaryStatus: 'in_progress' as const,
              summaryStartedAt: item.summaryStartedAt || Date.now(),
            }
          : item),
      };
      await putBook(markedBook);
      setBooks(current => current.map(item => item.id === markedBook.id ? markedBook : item));
      const indexInBook = book.chapters.findIndex(item => item.id === chapter.id);
      const context = book.chapters.slice(0, indexInBook)
        .map((item, index) => 'Chapitre ' + (index + 1) + ' : ' + item.title).join(', ');

      const requestSummary = async (
        text: string, parts?: string[], mode: 'notes' | 'overview' | 'actions' | 'essentials' | 'understanding' | 'takeaways' | 'application' = 'notes'
      ): Promise<string> => {
        const body = JSON.stringify({
          chapterText: text,
          summaryParts: parts,
          summaryMode: mode,
          chapterTitle: chapter.title,
          bookTitle: book.title,
          previousChaptersContext: context,
          provider: settings.ttsProvider || 'deepinfra',
        });
        let lastStatus = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch('/api/chapters/summary', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
                'x-tts-provider': settings.ttsProvider || 'deepinfra',
              },
              body,
            });
            lastStatus = res.status;
            if (res.ok) {
              const data = await res.json();
              if (typeof data.summary === 'string' && data.summary.trim()) return data.summary.trim();
              throw new Error('La fiche reçue est vide.');
            }
            if (res.status !== 429 && res.status < 500) {
              throw new Error('Ce chapitre ne peut pas être analysé pour le moment.');
            }
            console.warn('Auralis chapter summary status:', res.status);
          } catch (error) {
            if (error instanceof Error && /fiche reçue est vide|ne peut pas être analysé/.test(error.message)) throw error;
            console.warn('Auralis summary temporary error:', error);
          }
          if (attempt === 0) await new Promise<void>(resolve => setTimeout(resolve, 1800));
        }
        if (text.length > 2400 && lastStatus !== 429 && (!parts || parts.length === 0)) {
          const middle = Math.floor(text.length / 2);
          let cut = text.lastIndexOf('\n\n', middle);
          if (cut < text.length / 4) cut = text.lastIndexOf(' ', middle);
          if (cut < text.length / 4) cut = middle;
          const first = await requestSummary(text.slice(0, cut).trim(), undefined, 'notes');
          const second = await requestSummary(text.slice(cut).trim(), undefined, 'notes');
          return requestSummary('', [first, second], mode);
        }
        throw new Error(lastStatus === 429
          ? 'La lecture est très sollicitée en ce moment. Tes progrès ont été conservés.'
          : 'Ce passage n’a pas pu être analysé. Les étapes déjà terminées ont été conservées : relance la fiche pour reprendre.');
      };

      const source = chapter.text.trim();
      if (!source) throw new Error('Ce chapitre ne contient pas de texte à analyser.');
      const segments: string[] = [];
      for (let offset = 0; offset < source.length;) {
        let boundary = Math.min(offset + 9000, source.length);
        if (boundary < source.length) {
          const paragraph = source.lastIndexOf('\n\n', boundary);
          if (paragraph > offset + 5500) boundary = paragraph + 2;
        }
        segments.push(source.slice(offset, boundary));
        offset = boundary;
      }
      // Hash both the text and its position so cached notes cannot be mistaken
      // for another edition of the same book.
      const signature = (input: string): string => {
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
          hash ^= input.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        return input.length.toString(36) + '-' + (hash >>> 0).toString(36);
      };
      const saved = await getSummarySegments(book.id, chapter.id);
      const cached = new Map(saved.map(item => [item.id, item]));
      const getOrCreate = async (
        stage: number, position: number, keyText: string, create: () => Promise<string>
      ): Promise<string> => {
        const id = book.id + ':' + chapter.id + ':' + stage + ':' + position;
        const textHash = signature(keyText);
        const previous = cached.get(id);
        if (previous?.textHash === textHash && previous.text.trim()) return previous.text;
        const result = await create();
        const record = {
          id, bookId: book.id, chapterId: chapter.id,
          stage, index: position, textHash, text: result,
        };
        await saveSummarySegment(record);
        cached.set(id, record);
        return result;
      };

      let finalText = source;
      let finalParts: string[] | undefined;
      let analysisHasGaps = false;

      if (segments.length > 1) {
        let notes: string[] = [];
        for (let index = 0; index < segments.length; index++) {
          setSummaryProgress('Analyse du passage ' + (index + 1) + '/' + segments.length +
            ' · les étapes terminées sont conservées');
          try {
            notes.push(await getOrCreate(0, index, segments[index],
              () => requestSummary(segments[index], undefined, 'notes')));
          } catch (error) {
            // A single upstream outage must not erase all the previous chapters'
            // work. Keep a *clearly provisional* source excerpt, never an
            // invented summary, and retry this uncached passage next time.
            analysisHasGaps = true;
            console.warn('Auralis: chapter passage unavailable', index + 1, error);
            notes.push('[Passage ' + (index + 1) + ' à réanalyser : extrait du texte original]\n' +
              segments[index].trim().slice(0, 1800));
          }
        }
        let stage = 1;
        while (notes.length > 2) {
          const combined: string[] = [];
          for (let index = 0; index < notes.length; index += 2) {
            const group = notes.slice(index, index + 2);
            if (group.length === 1) {
              combined.push(group[0]);
              continue;
            }
            setSummaryProgress('Regroupement de la fiche · étape ' + stage);
            try {
              combined.push(await getOrCreate(stage, Math.floor(index / 2), group.join('\n\n'),
                () => requestSummary('', group, 'notes')));
            } catch (error) {
              // Recover with the already analysed facts instead of throwing
              // away 20+ successful requests because the last merge failed.
              analysisHasGaps = true;
              console.warn('Auralis: keeping unmerged reading notes', stage, index, error);
              combined.push(group.join('\n\n'));
            }
          }
          notes = combined;
          stage++;
        }
        finalText = '';
        finalParts = notes;
      }

      // Finalise in small, independently cached sections. A timeout in one
      // section must not destroy the other completed parts of the reading sheet.
      const finalSignature = (finalParts || [finalText]).join('\n\n');
      const sections: Array<{
        stage: number;
        mode: 'essentials' | 'understanding' | 'takeaways' | 'application';
        label: string;
        heading: RegExp;
      }> = [
        { stage: 120, mode: 'essentials', label: "L'essentiel en quelques lignes",
          heading: /###\s*L['’]essentiel en quelques lignes/i },
        { stage: 121, mode: 'understanding', label: 'Comprendre le chapitre',
          heading: /###\s*Comprendre le chapitre/i },
        { stage: 122, mode: 'takeaways', label: "Ce qu'il faut retenir",
          heading: /###\s*(Ce qu['’]il faut retenir|Les personnages et leur stratégie)/i },
        { stage: 123, mode: 'application', label: 'Passer à la pratique',
          heading: /###\s*(Passer à la pratique|Les tournants de l['’]histoire)/i },
      ];
      const completed: string[] = [];
      let unfinished = 0;
      const keepDraft = async (provisional: boolean): Promise<void> => {
        const draft: Book = {
          ...book, updatedAt: Date.now(),
          chapters: book.chapters.map(item => item.id === chapter.id
            ? {
              ...item,
              summary: completed.join('\n\n'),
              summaryProvisional: provisional,
              summaryStatus: provisional ? 'interrupted' as const : 'complete' as const,
              summaryStartedAt: undefined,
            }
            : item),
        };
        await putBook(draft);
        setBooks(current => current.map(item => item.id === draft.id ? draft : item));
      };

      for (let index = 0; index < sections.length; index++) {
        const section = sections[index];
        setSummaryProgress('Rédaction de la section ' + (index + 1) + '/' + sections.length +
          ' · les sections déjà rédigées sont enregistrées');
        try {
          const text = await getOrCreate(section.stage, 0, 'section-v3:' + section.mode + ':' + finalSignature,
            async () => {
              const response = await requestSummary(finalText, finalParts, section.mode);
              if (!section.heading.test(response) || response.trim().length < 90) {
                throw new Error('Section incomplète : ' + section.label);
              }
              return response;
            });
          if (!section.heading.test(text)) throw new Error('Section mal formée : ' + section.label);
          completed.push(text);
        } catch (error) {
          unfinished++;
          console.warn('Auralis: chapter summary section pending', section.mode, error);
          completed.push('### ' + section.label + '\n' +
            '*Cette section n’a pas pu être finalisée. Les passages déjà analysés ' +
            'sont conservés. Utilise « Actualiser la fiche » pour terminer cette partie.*');
        }
        // Persist after EVERY section, so closing the tab cannot erase the
        // completed parts of the fiche, even if later requests fail.
        await keepDraft(true);
      }

      if (analysisHasGaps) {
        completed.push('### Analyse à compléter\n' +
          'Certains passages ou regroupements ont été indisponibles. Cette fiche est provisoire. ' +
          'Relance « Actualiser la fiche » pour analyser les passages manquants sans perdre les étapes réussies.');
      }
      const isProvisional = unfinished > 0 || analysisHasGaps;
      await keepDraft(isProvisional);
      if (!isProvisional) await clearSummarySegments(book.id, chapter.id).catch(() => undefined);
      showToast(isProvisional
        ? (sections.length - unfinished) + '/' + sections.length +
          ' sections préparées. La fiche provisoire est sauvegardée : actualise-la pour compléter les passages manquants.'
        : 'Fiche de lecture complète !');
    } catch (error) {
      // Retain the visible "Reprendre la fiche" state even if the browser's
      // request failed before any final section could be displayed.
      try {
        const latest = await getBooks();
        const savedBook = latest.find(item => item.id === book.id);
        if (savedBook) {
          const recovered: Book = {
            ...savedBook,
            updatedAt: Date.now(),
            chapters: savedBook.chapters.map(item => item.id === chapter.id
              ? { ...item, summaryStatus: 'interrupted' as const }
              : item),
          };
          await putBook(recovered);
          setBooks(current => current.map(item => item.id === recovered.id ? recovered : item));
        }
      } catch (storageError) {
        console.warn('Auralis: unable to persist summary interruption', storageError);
      }
      showToast(error instanceof Error ? error.message : 'Impossible de préparer cette fiche.', true);
    } finally {
      setSummaryLoading(false);
      setSummaryProgress('');
    }
  }

  async function copyChapterSummary(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        if (!copied) throw new Error('Copie impossible');
      }
      showToast('Fiche copiée. Tu peux la coller où tu veux.');
    } catch { showToast('La copie a échoué. Sélectionne le texte de la fiche pour le copier.', true); }
  }

  async function playSummaryWithIA(summaryText: string): Promise<void> {
    if (!summaryText) return;
    stopAllPlayback();
    const clean = summaryText.replace(/###|---|\*\*|⚡|📖|🧠|👥|💡|🔗|🎯/g, ' ').trim();
    setGeneration({ active: true, progress: 0, label: 'Lecture du résumé IA', mode: 'chapter' });
    try {
      // Génération par petits segments : fiable avec les limites d'exécution Netlify.
      const result = await synthesizeChapter(
        clean,
        (progress, label) => setGeneration({ active: true, progress, label, mode: 'chapter' }),
        () => false,
        settings.apiKey,
        settings.cloudVoice
      );
      const url = URL.createObjectURL(result.blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.currentTime = 0;
        await audioRef.current.play();
        setAudioPlaying(true);
        showToast('Lecture de la fiche lancée');
      }
    } catch (err: any) {
      showToast(err?.message || 'Impossible de lire cette fiche', true);
    } finally {
      setGeneration(null);
    }
  }

  async function testApiKey(): Promise<void> {
    const key = (settings.apiKey || '').trim();
    // Une clé saisie dans le navigateur est facultative :
    // sur Netlify elle peut être stockée côté serveur dans Environment variables.
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
        if (key) localStorage.setItem('auralis_api_key', key);
        if (key && (settings.ttsProvider || 'gemini') === 'gemini') {
          localStorage.setItem('auralis_gemini_api_key', key);
          void refreshGeminiVoiceData();
        }
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
    seekTo(audioCurrentTime + seconds);
  }

  function seekTo(target: number, autoStart = false): void {
    if (!playableAudioUrl || !audioRef.current) return;
    const total = currentAudio?.duration || audioDuration || 0;
    const clamped = Math.max(0, Math.min(total, target));
    const durations = currentAudio?.partDurations;
    if (durations?.length && currentAudio?.parts?.length) {
      let offset = 0;
      let index = 0;
      for (; index < durations.length - 1; index++) {
        if (clamped < offset + durations[index]) break;
        offset += durations[index];
      }
      const local = Math.max(0, Math.min(clamped - offset, Math.max(0, durations[index] - 0.05)));
      if (index !== audioPartIndex) {
        pendingPartSeek.current = { seconds: local, play: autoStart || audioPlaying };
        setAudioPartIndex(index);
      } else {
        audioRef.current.currentTime = local;
        if (autoStart) void audioRef.current.play().catch(() => undefined);
      }
    } else {
      audioRef.current.currentTime = clamped;
      if (autoStart) void audioRef.current.play().catch(() => undefined);
    }
    setAudioCurrentTime(clamped);
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
          if (audioRef.current && ((isCloudBook && next.audioUrl) || (audioMap[next.id] && isCloudGeneratedAudio(audioMap[next.id])))) {
            void audioRef.current.play().catch(() => undefined);
            setAudioPlaying(true);
          } else {
            showToast('Le chapitre suivant n’a pas encore été généré.');
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

  async function ensureVoiceReady(): Promise<boolean> {
    // Netlify /health only proves that a key exists, not that speech works.
    // Confirm that Kokoro actually returns audio before a large chapter.
    if (lastVerifiedSpeech.current?.expiresAt && lastVerifiedSpeech.current.expiresAt > Date.now()) {
      setPreferredSpeechRoute(lastVerifiedSpeech.current.route);
      return true;
    }
    const routes: SpeechRoute[] = ['openai', 'inference'];
    const failures: string[] = [];
    for (const route of routes) {
      try {
        const res = await fetch('/api/validate-key', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
            'x-tts-provider': 'deepinfra',
          },
          body: JSON.stringify({ provider: 'deepinfra', ttsRoute: route }),
          signal: AbortSignal.timeout(27000),
        });
        const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
        if (res.ok && payload.ok === true) {
          setPreferredSpeechRoute(route);
          lastVerifiedSpeech.current = { route, expiresAt: Date.now() + 10 * 60_000 };
          return true;
        }
        failures.push(route + ' (' + res.status + ')');
        if (res.status === 401 || res.status === 403) {
          showToast('La clé DeepInfra n’est pas acceptée par le service vocal. Vérifie la configuration Netlify.', true);
          return false;
        }
      } catch (error) {
        failures.push(route + ' (connexion interrompue)');
        console.warn('Auralis: Kokoro service check interrupted', route, error);
      }
    }
    showToast('Le service vocal DeepInfra ne produit aucun audio pour le moment : ' +
      failures.join(' ; ') +
      '. Aucun long chapitre n’a été lancé. Les passages déjà enregistrés sont conservés.', true);
    return false;
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
        (progress, label) =>
          setGeneration({ active: true, progress, label, mode }),
        () => cancelGeneration.current,
        settings.apiKey,
        settings.cloudVoice,
        { bookId: book.id, chapterId: chapter.id }
      );
      const record: AudioRecord = {
        id: `${book.id}:${chapter.id}`,
        bookId: book.id,
        chapterId: chapter.id,
        voiceId: result.engineVoiceId,
        blob: result.blob,
        parts: result.parts,
        partDurations: result.partDurations,
        duration: result.duration,
        createdAt: Date.now(),
      };
      await putAudio(record);
      // Only clear temporary segments AFTER the completed chapter is durable.
      await clearSpeechSegments(book.id, chapter.id).catch(() => undefined);
      setAudioMap(current => ({ ...current, [chapter.id]: record }));
      setCachedAudioPassages(current => ({ ...current, [chapter.id]: 0 }));
      return record;
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Impossible de créer cet audio.',
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
    if (record) showToast(`Chapitre prêt · ${audioSourceLabel(record.voiceId)}. Fichier sauvegardé sur cet appareil.`);
  }

  async function generateAll(): Promise<void> {
    if (!selectedBook) return;
    cancelGeneration.current = false;
    const ready = await ensureVoiceReady();
    if (!ready) return;
    const provider = settings.ttsProvider || 'gemini';
    const defaultCloudVoice =
      provider === 'deepinfra' ? 'ff_siwis' : provider === 'aws-polly' ? 'Lea' : 'Kore';
    const expectedVoiceId = `${provider}:${provider === 'deepinfra' && settings.cloudVoice === 'Kore' ? defaultCloudVoice : settings.cloudVoice || defaultCloudVoice}`;
    let completed = 0;
    for (let index = 0; index < selectedBook.chapters.length; index += 1) {
      if (cancelGeneration.current) break;
      const chapter = selectedBook.chapters[index];
      if (audioMap[chapter.id]?.voiceId === expectedVoiceId) {
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
      records.filter(isCloudGeneratedAudio).map(record => [record.chapterId, record])
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
          parts: map[chapter.id].parts,
        }))
      );
      saveAs(zip, `${sanitizeFileName(selectedBook.title)} - Livre audio.zip`);
      showToast('Ton livre audio est téléchargé.');
    } catch {
      showToast('Impossible de préparer le téléchargement. Vérifie l’espace disponible et réessaie.', true);
    } finally {
      setGeneration(null);
    }
  }

  async function downloadChapter(record: AudioRecord, chapterTitle: string, index: number): Promise<void> {
    try {
      const prefix = String(index + 1).padStart(2, '0');
      const name = prefix + ' - ' + sanitizeFileName(chapterTitle);
      if (record.parts?.length && record.parts.length > 1) {
        const archive = await makeBookZip(chapterTitle, [{
          index,
          title: chapterTitle,
          blob: record.blob,
          parts: record.parts,
        }]);
        saveAs(archive, name + ' - Audio.zip');
      } else {
        saveAs(record.blob, name + '.wav');
      }
    } catch {
      showToast('Impossible de télécharger cet audio pour le moment.', true);
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
    showToast(deleteTarget.cloudJobId ? 'Livre retiré de ta bibliothèque.' : 'Livre supprimé de cet appareil.');
  }

  return (
    <div className="lv-app">
      <aside className="lv-sidebar">
        <div className="lv-brand">
          <div className="lv-logo">
            <Headphones size={20} />
          </div>
          <div>
            <strong>Auralis</strong>
            <small>Vos livres, autrement</small>
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
              Tes livres restent sur cet appareil. Prépare leur version audio ou une fiche de lecture quand tu le souhaites.
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
                : 'Votre bibliothèque audio'}
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
                title="Lecture disponible"
              >
                <CheckCircle2 size={12} />
                <span>Prêt à écouter</span>
              </span>
            ) : null}
            <button
              className="lv-icon-button lv-developer-control"
              title="Synchroniser avec GitHub"
              onClick={() => setGithubModalOpen(true)}
            >
              <GitBranch size={17} />
            </button>
            <a
              href="/api/download-zip"
              download="Auralis-LivreVox-code.zip"
              className="lv-icon-button lv-developer-control"
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
              onClick={() => {
                setSettingsOpen(true);
                void refreshGeminiVoiceData();
              }}
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
                  <ShieldCheck size={13} /> Vos livres, à lire et à écouter
                </div>
                <h1>
                  Tes livres prennent <em>vie à l'oral.</em>
                </h1>
                <p>
                  Ajoute un livre au format PDF, retrouve ses chapitres et écoute-les à ton rythme. Pour mieux retenir l'essentiel, crée aussi une fiche de lecture claire et pratique.
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
                  <strong>Ajoute un livre à ta bibliothèque</strong>
                  <span>Sélectionne un document PDF pour commencer</span>
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
                      <Sparkles size={15} /> Essayer avec un exemple
                    </button>
                  </div>
                </div>
                <div className="lv-features">
                  <div className="lv-feature">
                    <strong>
                      <WandSparkles size={14} /> Des chapitres bien organisés
                    </strong>
                    Retrouve les titres, parties et chapitres de ton livre, avec une navigation
                    simple et agréable.
                  </div>
                  <div className="lv-feature">
                    <strong>
                      <Zap size={14} /> Documents numérisés
                    </strong>
                    Les documents contenant du texte fonctionnent directement. Certains PDF scannés demandent une conversion supplémentaire.
                  </div>
                  <div className="lv-feature">
                    <strong>
                      <FileAudio size={14} /> Garde tes livres audio
                    </strong>
                    Prépare les chapitres à écouter, puis télécharge le livre
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
                      <span>{selectedBook.pages || '—'} pages</span>
                      <span>{totalWords.toLocaleString('fr-FR')} mots</span>
                      <span>~{totalMinutes} min</span>
                      <span>{formatBytes(selectedBook.sourceSize)}</span>
                      {selectedBook.ocrUsed && <span>Texte numérisé</span>}
                    </div>
                  </div>
                </div>
                <div className="lv-book-actions">
                  <button className="lv-secondary" onClick={() => setSettingsOpen(true)}>
                    <Settings size={14} /> Choisir la voix
                  </button>
                  <button className="lv-secondary" onClick={() => setTab('summary')}>
                    <Brain size={14} /> Fiche de lecture
                  </button>
                  <button className="lv-primary" onClick={() => setTab('export')}>
                    <WandSparkles size={14} /> Créer l'audio
                  </button>
                  <button
                    className="lv-secondary"
                    onClick={() => setDeleteTarget(selectedBook)}
                  >
                  <Trash2 size={14} /> Supprimer
                  </button>
                </div>
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
                  <Brain size={15} /> Fiche de lecture
                </button>
                <button
                  className={`lv-tab ${tab === 'export' ? 'active' : ''}`}
                  onClick={() => setTab('export')}
                >
                  <Sparkles size={15} /> Créer & télécharger
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
                            {currentAudio ? audioSourceLabel(currentAudio.voiceId) :
                              selectedChapter.audioUrl ? 'Livre audio prêt' :
                              'Audio non généré'}
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
                            className={`lv-paragraph-item ${idx === activeParagraphIndex && (audioPlaying) ? 'active' : ''}`}
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
                            {audioPlaying ? (
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
                          {playableAudioUrl ? formatTime(audioCurrentTime) : '0:00'}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={playableAudioUrl ? (audioDuration || 1) : 100}
                          step={playableAudioUrl ? 0.5 : 1}
                          value={playableAudioUrl ? audioCurrentTime : 0}
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
                          title={audioPlaying ? 'Mettre en pause' : 'Lire l’audio'}
                          onClick={togglePlayPause}
                          aria-label={audioPlaying ? 'Mettre en pause' : 'Lire'}
                        >
                          {audioPlaying ? (
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
                            title="Ouvrir la fiche de lecture de ce chapitre"
                          >
                            <Brain size={13} />
                            <span>Fiche de lecture</span>
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
                        {chapter.audioUrl ? 'audio cloud prêt' : audioMap[chapter.id] ? audioSourceLabel(audioMap[chapter.id].voiceId) : 'pas encore généré'}
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
                          title="Consulter la fiche de ce chapitre"
                        >
                          <Brain size={13} /> Fiche de lecture
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
                        <Brain size={20} /> Comprendre et retenir — {selectedChapter.title}
                      </h2>
                      <p>
                        Retrouve les idées importantes, les actions à essayer ou les choix des personnages, sans connaître la suite.
                      </p>
                    </div>
                    <div className="lv-summary-actions">
                      {selectedChapter.summary && (
                        <button className="lv-secondary" title="Copier la fiche" onClick={() => void copyChapterSummary(selectedChapter.summary!)}>
                          <FileText size={14} /> Copier la fiche
                        </button>
                      )}
                      {selectedChapter.summary && (
                        <button
                          className="lv-secondary"
                          onClick={() => void playSummaryWithIA(selectedChapter.summary!)}
                          disabled={summaryLoading}
                          title="Écouter cette fiche"
                        >
                          <Volume2 size={14} /> Écouter la fiche
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
                            <RefreshCw size={14} className="animate-spin" /> Préparation en cours…
                          </>
                        ) : selectedChapter.summaryStatus === 'in_progress' || selectedChapter.summaryStatus === 'interrupted' ||
                          (!selectedChapter.summary &&
                            savedSummaryWork?.chapterKey === selectedBook.id + ':' + selectedChapter.id &&
                            savedSummaryWork.count > 0) ? (
                          <>
                            <RotateCcw size={14} /> Reprendre la fiche
                          </>
                        ) : selectedChapter.summary ? (
                          <>
                            <RotateCcw size={14} /> Actualiser la fiche
                          </>
                        ) : (
                          <>
                            <Sparkles size={14} /> Créer la fiche du chapitre
                          </>
                        )}
                      </button>
                    </div>
                    {summaryLoading && summaryProgress && (
                      <p className="lv-summary-note" role="status">{summaryProgress}</p>
                    )}
                    {!summaryLoading && !selectedChapter.summary &&
                      savedSummaryWork?.chapterKey === selectedBook.id + ':' + selectedChapter.id &&
                      savedSummaryWork.count > 0 && (
                      <p className="lv-summary-note" role="status">
                        {savedSummaryWork.count} étape(s) d'analyse sauvegardée(s) sur cet appareil.
                        La fiche n'a pas encore été assemblée. Clique sur « Reprendre la fiche » pour continuer sans recommencer ces étapes.
                      </p>
                    )}
                    {(selectedChapter.summaryStatus === 'in_progress' || selectedChapter.summaryStatus === 'interrupted') && !summaryLoading && (
                      <p className="lv-summary-note" role="status">
                        Génération interrompue ou page rechargée. Les passages déjà analysés ont été sauvegardés sur cet appareil.
                        Clique sur « Reprendre la fiche » pour continuer : fermer l'onglet interrompt la génération, mais pas les étapes enregistrées.
                      </p>
                    )}
                    {selectedChapter.summaryProvisional && !summaryLoading &&
                      selectedChapter.summaryStatus !== 'interrupted' && (
                      <p className="lv-summary-note">Fiche provisoire : certains passages restent à regrouper. Utilise « Actualiser la fiche » pour terminer.</p>
                    )}
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
                          {selectedChapter.summaryStatus === 'in_progress' || selectedChapter.summaryStatus === 'interrupted'
                            ? 'Fiche commencée, à reprendre'
                            : 'Aucune fiche pour « ' + selectedChapter.title + ' » pour le moment'}
                        </h3>
                        <p style={{ maxWidth: '520px', margin: '0 auto 20px', fontSize: '13px', lineHeight: 1.6 }}>
                          Découvre l'essentiel du chapitre : des actions concrètes pour un livre pratique, ou les choix et les plans des personnages pour un roman.
                        </p>
                        <button
                          className="lv-primary"
                          style={{ width: 'auto', margin: '0 auto' }}
                          onClick={() => void generateChapterSummary(selectedChapter)}
                          disabled={summaryLoading}
                        >
                          <Sparkles size={15} /> {summaryLoading ? 'Préparation...' : 'Créer ma fiche'}
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
                      <Volume2 size={13} /> Écoute personnalisée
                    </div>
                    <h2>{isCloudBook ? 'Ton livre prend vie' : 'Crée ton livre audio'}</h2>
                    <p>{isCloudBook ? `Ton livre se prépare chapitre par chapitre. Progression : ${selectedBook.cloudProcessingProgress ?? 0} %.` : 'Choisis une voix, puis prépare un chapitre ou tout le livre. Tes fichiers audio restent enregistrés sur cet appareil.'}</p>
                    <div className="lv-stat-grid">
                      <div className="lv-stat">
                        <strong>
                          {generatedCount}/{selectedBook.chapters.length}
                        </strong>
                        <span>chapitres prêts</span>
                      </div>
                      <div className="lv-stat">
                        <strong>À ton rythme</strong>
                        <span>Voix personnalisée</span>
                      </div>
                      <div className="lv-stat">
                        <strong>Audio</strong>
                        <span>{isCloudBook ? 'chapitres à écouter' : 'à télécharger'}</span>
                      </div>
                    </div>
                    <div className="lv-export-actions">
                      {!isCloudBook && (
                        <button className="lv-secondary" style={{ width: 'auto' }} onClick={() => setSettingsOpen(true)}>
                          <Settings size={15} /> Choisir la voix
                        </button>
                      )}
                      {isCloudBook ? (
                        <>
                          <button className="lv-primary" style={{ width: 'auto' }} onClick={() => selectedBook.cloudJobId && void continueCloudPipeline(selectedBook.cloudJobId, null, selectedBook.id)}>
                            <RotateCcw size={15} /> Reprendre la préparation
                          </button>
                          {!selectedBook.cloudTtsConfigured && <button className="lv-secondary" disabled={!selectedChapter || Boolean(generation?.active)} onClick={() => void generateCurrent()}><WandSparkles size={15} /> Créer l'audio du chapitre</button>}
                        </>
                      ) : (
                        <>
                          <button className="lv-primary" style={{ width: 'auto' }} disabled={!selectedChapter || Boolean(generation?.active)} onClick={() => void generateCurrent()}><WandSparkles size={15} /> Créer l'audio du chapitre</button>
                          <button className="lv-secondary" disabled={Boolean(generation?.active)} onClick={() => void generateAll()}><RotateCcw size={15} /> Créer l'audio du livre</button>
                          <button className="lv-secondary" disabled={generatedCount !== selectedBook.chapters.length || Boolean(generation?.active)} onClick={() => void exportBook()}><Download size={15} /> Télécharger le livre audio</button>
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
                        {(generation.mode === 'book' || generation.mode === 'chapter') && (
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
                          {chapter.audioUrl ? 'Audio cloud prêt' : audioMap[chapter.id] ? audioSourceLabel(audioMap[chapter.id].voiceId) : cachedAudioPassages[chapter.id] ? cachedAudioPassages[chapter.id] + ' passages sauvegardés · à reprendre' : 'À générer'}
                        </span>
                        <div className="lv-table-actions">
                          {chapter.audioUrl ? (
                            <a className="lv-mini-button" title="Ouvrir l’audio cloud" href={chapter.audioUrl} target="_blank" rel="noreferrer"><Play size={14} /></a>
                          ) : audioMap[chapter.id] ? (
                            <>
                              <button
                                className="lv-mini-button"
                                title={audioMap[chapter.id].parts?.length ? 'Télécharger toutes les parties audio' : 'Télécharger le chapitre'}
                                onClick={() => void downloadChapter(audioMap[chapter.id], chapter.title, index)}
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
                              title={cachedAudioPassages[chapter.id] ? 'Reprendre les passages audio sauvegardés' : "Créer l'audio du chapitre"}
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

                  {/* Options de développement hors du parcours grand public */}
                  <div className="lv-card lv-developer-control" style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
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
          <div className="lv-card lv-modal lv-settings-modal" role="dialog" aria-modal="true" aria-label="Réglages Auralis">
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
              <label htmlFor="cloud-voice">
                {(settings.ttsProvider || 'gemini') === 'gemini'
                  ? 'Voix Gemini'
                  : (settings.ttsProvider === 'deepinfra' ? 'Voix de lecture' : 'Voix Cloud')}
              </label>
              <details style={{ position: 'relative', width: '100%' }}>
                <summary
                  className="lv-select"
                  aria-label="Choisir une voix de synthèse"
                  style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                >
                  <span>{((settings.ttsProvider || 'gemini') === 'gemini' ? geminiVoiceOptions : settings.ttsProvider === 'deepinfra' ? KOKORO_VOICES : [{ id: 'Lea', label: 'Léa · Français (Polly)', displayName: 'Léa' }])
                    .find(voice => voice.id === (settings.cloudVoice || 'Kore'))?.label || settings.cloudVoice || 'Kore'}</span>
                  <ChevronRight size={16} style={{ transform: 'rotate(90deg)', flexShrink: 0 }} />
                </summary>
                <div
                  role="listbox"
                  aria-label="Voix disponibles"
                  style={{
                    maxHeight: 'min(270px, 45vh)',
                    overflowY: 'auto',
                    overscrollBehavior: 'contain',
                    background: '#182433',
                    border: '1px solid rgba(167, 139, 250, 0.45)',
                    borderRadius: 12,
                    padding: 6,
                    marginTop: 6,
                    boxShadow: '0 12px 28px rgba(0,0,0,.35)',
                  }}
                >
                  {((settings.ttsProvider || 'gemini') === 'gemini' ? geminiVoiceOptions : settings.ttsProvider === 'deepinfra' ? KOKORO_VOICES : [{ id: 'Lea', label: 'Léa · Français (Polly)', displayName: 'Léa' }]).map(voice => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={(settings.cloudVoice || 'Kore') === voice.id}
                      key={voice.id}
                      onClick={event => {
                        setSettings(current => ({ ...current, cloudVoice: voice.id }));
                        event.currentTarget.closest('details')?.removeAttribute('open');
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: 8,
                        border: 'none',
                        color: '#f8fafc',
                        cursor: 'pointer',
                        background: (settings.cloudVoice || 'Kore') === voice.id ? '#53407a' : 'transparent',
                      }}
                    >
                      {voice.label}
                    </button>
                  ))}
                </div>
              </details>

              {(settings.ttsProvider || 'gemini') === 'gemini' && (
                <>
                  <input
                    className="lv-input"
                    style={{ marginTop: 8 }}
                    value={settings.cloudVoice || 'Kore'}
                    onChange={event =>
                      setSettings(current => ({
                        ...current,
                        cloudVoice: event.target.value.trim(),
                      }))
                    }
                    placeholder="Kore, voice_..., voicekey_... ou ID de la bibliothèque Gemini"
                    aria-label="ID de voix Gemini personnalisé"
                  />
                  <button
                    type="button"
                    className="lv-secondary"
                    style={{ width: 'auto', marginTop: 8 }}
                    onClick={() => void refreshGeminiVoiceData()}
                  >
                    Actualiser les voix Gemini
                  </button>
                </>
              )}
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>
                {(settings.ttsProvider || 'gemini') === 'gemini'
                  ? 'Choisis parmi les 30 voix studio Gemini, les voix de la bibliothèque étendue, ou colle directement un ID voice_… / voicekey_….'
                  : 'Cette voix racontera les chapitres de ton livre.'}
              </p>
            </div>

            <div className="lv-field">
              <label htmlFor="ocr-lang">Langue du document</label>
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
                  Essayer de lire les pages scannées lorsque le document ne contient
                  pas de texte lisible.
                </span>
              </label>
            </div>
            <details className="lv-advanced-settings">
              <summary>Options avancées</summary>
            <div className="lv-field">
              <label htmlFor="tts-provider">Service de lecture</label>
              <select
                id="tts-provider"
                className="lv-select"
                value={settings.ttsProvider || 'gemini'}
                onChange={event => {
                  const provider = event.target.value as AppSettings['ttsProvider'];
                  setSettings(current => ({ ...current, ttsProvider: provider, cloudVoice: provider === 'deepinfra' ? 'ff_siwis' : provider === 'aws-polly' ? 'Lea' : 'Kore', apiKey: '' }));
                  setKeyTestStatus('idle');
                  setKeyTestError(null);
                }}
              >
                <option value="deepinfra">Voix standard</option>
              </select>
            </div>

            <div className="lv-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="provider-key">
                  Code de connexion (facultatif)
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
                placeholder="Laisser vide si déjà connecté"
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
                disabled={keyTestStatus === 'testing'}
              >
                {keyTestStatus === 'testing' ? 'Test...' : 'Tester la connexion'}
              </button>

              {keyTestStatus === 'valid' && (
                <p style={{ fontSize: '0.8rem', color: '#4ade80', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={13} /> Connexion vérifiée.
                </p>
              )}
              {keyTestStatus === 'invalid' && (
                <p style={{ fontSize: '0.8rem', color: '#f87171', marginTop: 4 }}>
                  ✕ {keyTestError || 'Connexion impossible.'}
                </p>
              )}
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>
                Cette option est réservée à la configuration avancée du service.
              </p>
            </div>
            </details>
            <div className="lv-modal-actions">
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

      {/* Audio element persists while navigating and changes tracks only between long-part files. */}
      <audio
        ref={audioRef}
        src={playableAudioUrl || undefined}
        playsInline
        preload="metadata"
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        onTimeUpdate={() => {
          if (!audioRef.current) return;
          setAudioCurrentTime(audioPartOffset + audioRef.current.currentTime);
          setAudioDuration(currentAudio?.duration || audioRef.current.duration || 0);
        }}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (!audio) return;
          audio.playbackRate = settings.rate;
          setAudioDuration(currentAudio?.duration || audio.duration || 0);
          const resume = pendingChapterResume.current;
          if (resume && resume.bookId === selectedBook?.id && resume.chapterId === selectedChapter?.id) {
            pendingChapterResume.current = null;
            seekTo(resume.seconds, true);
            return;
          }
          const pending = pendingPartSeek.current;
          if (pending) {
            pendingPartSeek.current = null;
            audio.currentTime = Math.min(pending.seconds, Math.max(0, audio.duration - 0.05));
            if (pending.play) void audio.play().catch(() => undefined);
          }
        }}
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onEnded={() => {
          if (currentAudio?.parts && audioPartIndex + 1 < currentAudio.parts.length) {
            pendingPartSeek.current = { seconds: 0, play: true };
            setAudioPartIndex(index => index + 1);
            return;
          }
          setAudioPlaying(false);
          if (autoPlayNext) goToNextChapter(true);
        }}
      />

      {/* Barre de lecture fixe en bas d'écran (Sticky Docked Player) uniquement hors onglet lecteur */}
      {selectedBook && selectedChapter && tab !== 'listen' && (playableAudioUrl || audioPlaying) && !dockedDismissed && (
        <div className="lv-docked-player">
          <div className="lv-docked-left">
            <div className="lv-player-cover" style={{ width: '38px', height: '38px', borderRadius: '10px' }}>
              {audioPlaying ? (
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
              <button className="lv-ctrl-btn-play" style={{ width: '40px', height: '40px' }} onClick={togglePlayPause} title={audioPlaying ? 'Pause' : 'Lecture'}>
                {audioPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: '2px' }} />}
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
              {playableAudioUrl ? `${formatTime(audioCurrentTime)} / ${formatTime(audioDuration || selectedChapter.estimatedMinutes * 60)}` : '0:00'}
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
                <Volume2 size={13} /> {currentAudio ? audioSourceLabel(currentAudio.voiceId) :
                  playableAudioUrl ? 'Audio distant' : 'Audio non généré'}
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
              {audioPlaying ? (
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
                <span className="lv-time-display">{playableAudioUrl ? formatTime(audioCurrentTime) : '0:00'}</span>
                <input
                  type="range"
                  min={0}
                  max={playableAudioUrl ? (audioDuration || 1) : 100}
                  step={playableAudioUrl ? 0.5 : 1}
                  value={playableAudioUrl ? audioCurrentTime : 0}
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
                  {audioPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" style={{ marginLeft: '3px' }} />}
                </button>
                <button className="lv-ctrl-btn" style={{ width: '48px', height: '48px' }} onClick={() => handleSkip(15)} title="+15s">
                  <RotateCw size={18} />
                  <span className="lv-skip-label">15</span>
                </button>
                <button className="lv-ctrl-btn" style={{ width: '48px', height: '48px' }} onClick={() => goToNextChapter(false)} title="Suivant">
                  <SkipForward size={20} />
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px', flexWrap: 'wrap' }}>
                <label htmlFor="immersive-playback-speed" style={{ color: '#cbd5e1', fontSize: '13px' }}>Vitesse de lecture</label>
                <select
                  id="immersive-playback-speed"
                  aria-label="Accélérer ou ralentir la lecture"
                  className="lv-rate"
                  value={settings.rate}
                  onChange={event => updateRate(Number(event.target.value))}
                >
                  {SPEEDS.map(rate => (
                    <option key={rate} value={rate}>{rate}×</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="lv-immersive-reader">
              {paragraphs.map((para, idx) => (
                <p
                  key={idx}
                  className={`lv-paragraph-item ${idx === activeParagraphIndex && (audioPlaying) ? 'active' : ''}`}
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
