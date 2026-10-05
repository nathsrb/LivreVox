import { api, image } from '@appdeploy/client';

export const CLOUD_THRESHOLD_BYTES = 8 * 1024 * 1024;

type ProgressCallback = (stage: string, progress: number) => void;

export type CloudChapterStatus = {
  id: string;
  title: string;
  text: string;
  words: number;
  estimatedMinutes: number;
  pageStart: number;
  pageEnd: number;
  audioUrl?: string;
  audioMimeType?: string;
};

export type CloudJobStatus = {
  id: string;
  title: string;
  name: string;
  size: number;
  status: string;
  pages: number;
  nextPage: number;
  processingProgress: number;
  audioReady: number;
  ttsConfigured: boolean;
  ttsProvider: string;
  needsOcrPage?: number | null;
  error?: string;
  chapters: CloudChapterStatus[];
};

export type CloudCapabilities = {
  cloud: boolean;
  ttsConfigured: boolean;
  ttsProvider: string;
  chunkUpload: boolean;
  ocr: boolean;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.length)));
  }
  return btoa(binary);
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Échec de la transmission cloud.');
}

export async function getCloudCapabilities(): Promise<CloudCapabilities> {
  const response = await api.get('/api/cloud/capabilities');
  return response.data as CloudCapabilities;
}

export async function uploadPdfToCloud(file: File, onProgress: ProgressCallback): Promise<string> {
  const start = await api.post('/api/cloud/jobs', {
    name: file.name,
    title: file.name.replace(/\.pdf$/i, '').trim() || 'Livre sans titre',
    size: file.size,
    mimeType: file.type || 'application/pdf',
  });
  const { id, chunkSize } = start.data as { id: string; chunkSize: number };
  const totalParts = Math.ceil(file.size / chunkSize);
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= totalParts) return;
      const begin = index * chunkSize;
      const end = Math.min(file.size, begin + chunkSize);
      const data = arrayBufferToBase64(await file.slice(begin, end).arrayBuffer());
      await withRetry(() => api.post(`/api/cloud/jobs/${id}/chunk`, { index, data }));
      completed += 1;
      const ratio = completed / Math.max(1, totalParts);
      onProgress(`Envoi cloud · bloc ${completed}/${totalParts}`, 4 + Math.round(ratio * 54));
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  onProgress('Validation du fichier dans le cloud', 60);
  await api.post(`/api/cloud/jobs/${id}/complete`, { totalParts });
  return id;
}

export async function getCloudJob(jobId: string): Promise<CloudJobStatus> {
  const response = await api.get(`/api/cloud/jobs/${jobId}`);
  return response.data as CloudJobStatus;
}

export async function processCloudStep(jobId: string): Promise<CloudJobStatus> {
  const response = await api.post(`/api/cloud/jobs/${jobId}/process-next`, {});
  return response.data as CloudJobStatus;
}

export async function generateCloudAudioStep(jobId: string): Promise<CloudJobStatus> {
  const response = await api.post(`/api/cloud/jobs/${jobId}/tts-next`, {});
  return response.data as CloudJobStatus;
}

export async function submitCloudOcrPage(jobId: string, pageNumber: number, pageImage: Blob): Promise<CloudJobStatus> {
  const prepared = await image.resizeIfNeeded(pageImage, { maxDimension: 1600, maxPixels: 2_000_000, quality: 0.84, mimeType: 'image/jpeg' });
  const response = await api.post(`/api/cloud/jobs/${jobId}/ocr-page`, {
    pageNumber,
    image: { data: prepared.data, mimeType: prepared.mimeType },
  });
  return response.data as CloudJobStatus;
}

export async function deleteCloudJob(jobId: string): Promise<void> {
  await api.delete(`/api/cloud/jobs/${jobId}`);
}
