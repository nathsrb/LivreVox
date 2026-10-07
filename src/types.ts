export type Chapter = {
  id: string;
  title: string;
  text: string;
  words: number;
  estimatedMinutes: number;
  audioUrl?: string;
  audioMimeType?: string;
  pageStart?: number;
  pageEnd?: number;
  summary?: string;
  summaryLoading?: boolean;
  lastPositionSeconds?: number;
};

export type Book = {
  id: string;
  title: string;
  sourceName: string;
  sourceSize: number;
  pages: number;
  createdAt: number;
  updatedAt: number;
  ocrUsed: boolean;
  chapters: Chapter[];
  progress: Record<string, number>;
  cloudJobId?: string;
  cloudStatus?: string;
  cloudProcessingProgress?: number;
  cloudAudioReady?: number;
  cloudTtsConfigured?: boolean;
  cloudTtsProvider?: string;
};

export type AudioRecord = {
  id: string;
  bookId: string;
  chapterId: string;
  voiceId: string;
  blob: Blob;
  duration: number;
  createdAt: number;
};

export type AppSettings = {
  rate: number;
  voiceId: string;
  cloudVoice?: string;
  systemVoiceUri: string;
  ocrLang: 'fra' | 'eng' | 'fra+eng';
  autoOcr: boolean;
  geminiApiKey?: string;
};

export type ImportProgress = {
  stage: string;
  progress: number;
};
