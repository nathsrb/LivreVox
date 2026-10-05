export const CLOUD_THRESHOLD_BYTES = Number.MAX_SAFE_INTEGER;

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

type ApiErrorPayload = { error?: string; message?: string };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + stride, bytes.length))
    );
  }
  return btoa(binary);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Les erreurs réseau/HTTP sont gérées juste après.
  }
  if (!response.ok) {
    const details = payload as ApiErrorPayload | null;
    throw new Error(
      details?.error || details?.message || `Erreur API (${response.status}).`
    );
  }
  return payload as T;
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts)
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Échec de la transmission.');
}

export async function getCloudCapabilities(): Promise<CloudCapabilities> {
  try {
    const health = await requestJson<{
      ttsConfigured?: boolean;
      provider?: string;
    }>('/api/health');
    return {
      cloud: false,
      chunkUpload: false,
      ocr: false,
      ttsConfigured: Boolean(health.ttsConfigured),
      ttsProvider: health.provider || 'local-fallback',
    };
  } catch {
    return {
      cloud: false,
      chunkUpload: false,
      ocr: false,
      ttsConfigured: false,
      ttsProvider: 'local-fallback',
    };
  }
}

// Ces fonctions sont conservées pour ouvrir d'anciens livres cloud sans lier
// le frontend à AppDeploy. Un hébergeur peut réimplémenter ces routes si besoin.
export async function uploadPdfToCloud(
  file: File,
  onProgress: ProgressCallback
): Promise<string> {
  const start = await requestJson<{ id: string; chunkSize: number }>('/api/cloud/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: file.name,
      title: file.name.replace(/\.pdf$/i, '').trim() || 'Livre sans titre',
      size: file.size,
      mimeType: file.type || 'application/pdf',
    }),
  });
  const { id, chunkSize } = start;
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
      const data = arrayBufferToBase64(
        await file.slice(begin, end).arrayBuffer()
      );
      await withRetry(() =>
        requestJson(`/api/cloud/jobs/${id}/chunk`, {
          method: 'POST',
          body: JSON.stringify({ index, data }),
        })
      );
      completed += 1;
      const ratio = completed / Math.max(1, totalParts);
      onProgress(
        `Envoi cloud · bloc ${completed}/${totalParts}`,
        4 + Math.round(ratio * 54)
      );
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  onProgress('Validation du fichier dans le cloud', 60);
  await requestJson(`/api/cloud/jobs/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ totalParts }),
  });
  return id;
}

export async function getCloudJob(jobId: string): Promise<CloudJobStatus> {
  return requestJson<CloudJobStatus>(`/api/cloud/jobs/${jobId}`);
}

export async function processCloudStep(jobId: string): Promise<CloudJobStatus> {
  return requestJson<CloudJobStatus>(`/api/cloud/jobs/${jobId}/process-next`, {
    method: 'POST',
    body: '{}',
  });
}

export async function generateCloudAudioStep(
  jobId: string
): Promise<CloudJobStatus> {
  return requestJson<CloudJobStatus>(`/api/cloud/jobs/${jobId}/tts-next`, {
    method: 'POST',
    body: '{}',
  });
}

export async function submitCloudOcrPage(
  jobId: string,
  pageNumber: number,
  pageImage: Blob
): Promise<CloudJobStatus> {
  const image = arrayBufferToBase64(await pageImage.arrayBuffer());
  return requestJson<CloudJobStatus>(`/api/cloud/jobs/${jobId}/ocr-page`, {
    method: 'POST',
    body: JSON.stringify({
      pageNumber,
      image: { data: image, mimeType: pageImage.type || 'image/jpeg' },
    }),
  });
}

export async function deleteCloudJob(jobId: string): Promise<void> {
  await requestJson(`/api/cloud/jobs/${jobId}`, { method: 'DELETE' });
}
