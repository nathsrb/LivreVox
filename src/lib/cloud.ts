type ProgressCallback = (stage: string, progress: number) => void;

export type CloudVoice = {
  id: string;
  name: string;
  gender: string;
};

export type CloudChapterStatus = {
  id: string;
  index: number;
  title: string;
  text: string;
  words: number;
  estimatedMinutes: number;
  hasAudio: boolean;
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
  processingProgress: number;
  audioReady: number;
  totalChapters?: number;
  ttsConfigured: boolean;
  ttsProvider: string;
  error?: string;
  chapters: CloudChapterStatus[];
  createdAt?: number;
  updatedAt?: number;
};

export type CloudCapabilities = {
  cloud: boolean;
  mode: string;
  ttsConfigured: boolean;
  ttsProvider: string;
  textModel: string;
  chunkUpload: boolean;
  ocr: boolean;
  voices: CloudVoice[];
};

const api = {
  get: async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return { data: await res.json() };
  },
  post: async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return { data: await res.json() };
  },
  delete: async (url: string) => {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return { data: await res.json() };
  },
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

export async function getCloudCapabilities(): Promise<CloudCapabilities> {
  try {
    const response = await api.get('/api/cloud/capabilities');
    return response.data as CloudCapabilities;
  } catch {
    return {
      cloud: true,
      mode: '100% Cloud Gemini Flash',
      ttsConfigured: false,
      ttsProvider: 'gemini-3.8-flash-lite-tts',
      textModel: 'gemini-3.8-flash',
      chunkUpload: true,
      ocr: true,
      voices: [
        { id: 'Kore', name: 'Kore (Voix féminine claire et douce)', gender: 'female' },
        { id: 'Puck', name: 'Puck (Voix masculine expressive)', gender: 'male' },
        { id: 'Zephyr', name: 'Zephyr (Voix calme et posée)', gender: 'neutral' },
        { id: 'Charon', name: 'Charon (Voix grave et narrative)', gender: 'male' },
        { id: 'Fenrir', name: 'Fenrir (Voix dynamique)', gender: 'male' },
      ],
    };
  }
}

export async function getCloudBooks(): Promise<CloudJobStatus[]> {
  try {
    const response = await api.get('/api/cloud/books');
    return response.data as CloudJobStatus[];
  } catch (err) {
    console.warn('Failed to fetch cloud books:', err);
    return [];
  }
}

export async function uploadPdfToCloud(file: File, onProgress: ProgressCallback): Promise<string> {
  onProgress('Lecture et encodage du PDF...', 10);
  const buffer = await file.arrayBuffer();

  // If file <= 15MB, upload directly in one call
  if (file.size <= 15 * 1024 * 1024) {
    onProgress('Envoi au cloud Gemini Flash...', 30);
    const base64Pdf = arrayBufferToBase64(buffer);
    const response = await api.post('/api/cloud/upload', {
      name: file.name,
      title: file.name.replace(/\.pdf$/i, '').trim(),
      base64Pdf,
    });
    onProgress('Analyse et structuration des chapitres par Gemini Flash...', 60);
    const data = response.data as { id: string };
    return data.id;
  }

  // Chunked upload for larger files
  onProgress('Initialisation de l’envoi cloud...', 5);
  const start = await api.post('/api/cloud/jobs', {
    name: file.name,
    title: file.name.replace(/\.pdf$/i, '').trim(),
    size: file.size,
  });
  const { id, chunkSize, totalParts } = start.data as { id: string; chunkSize: number; totalParts: number };

  for (let index = 0; index < totalParts; index += 1) {
    const begin = index * chunkSize;
    const end = Math.min(file.size, begin + chunkSize);
    const chunkData = arrayBufferToBase64(buffer.slice(begin, end));
    await api.post(`/api/cloud/jobs/${id}/chunk`, { index, data: chunkData });
    const progress = 10 + Math.round(((index + 1) / totalParts) * 50);
    onProgress(`Envoi cloud · bloc ${index + 1}/${totalParts}`, progress);
  }

  onProgress('Validation du document et analyse par Gemini Flash...', 65);
  await api.post(`/api/cloud/jobs/${id}/complete`, {});
  return id;
}

export async function getCloudJob(jobId: string): Promise<CloudJobStatus> {
  const response = await api.get(`/api/cloud/jobs/${jobId}`);
  return response.data as CloudJobStatus;
}

export async function generateCloudChapterAudio(
  jobId: string,
  chapterId: string,
  voiceName: string
): Promise<{ ok: boolean; audioUrl: string; audioReady: number }> {
  const response = await api.post(`/api/cloud/jobs/${jobId}/generate-audio`, {
    chapterId,
    voiceName,
  });
  return response.data as { ok: boolean; audioUrl: string; audioReady: number };
}

export async function generateNextCloudAudio(
  jobId: string,
  voiceName: string
): Promise<CloudJobStatus> {
  const response = await api.post(`/api/cloud/jobs/${jobId}/generate-audio`, {
    voiceName,
  });
  return response.data as CloudJobStatus;
}

export async function createDemoCloudBook(): Promise<CloudJobStatus> {
  const response = await api.post('/api/cloud/demo', {});
  return response.data as CloudJobStatus;
}

export async function deleteCloudJob(jobId: string): Promise<void> {
  await api.delete(`/api/cloud/jobs/${jobId}`);
}
