import { db, error, json, router, storage } from '@appdeploy/sdk';
import { Buffer } from 'node:buffer';
import { PDFDataRangeTransport, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

type JobStatus =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'waiting_ocr'
  | 'text_ready'
  | 'generating_audio'
  | 'complete'
  | 'failed'
  | 'password_protected';

type JobRecord = {
  title: string;
  name: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalParts: number;
  status: JobStatus;
  pages: number;
  nextPage: number;
  chapterIds: string[];
  audioReady: number;
  needsOcrPage: number | null;
  error: string;
  createdAt: number;
  updatedAt: number;
};

type ChapterRecord = {
  jobId: string;
  index: number;
  title: string;
  text: string;
  words: number;
  estimatedMinutes: number;
  pageStart: number;
  pageEnd: number;
  audioPath: string;
  audioMimeType: string;
  createdAt: number;
};

const JOBS = 'cloud_jobs';
const CHAPTERS = 'cloud_chapters';
const UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
const PROCESS_PAGES = 2;
const MAX_CHAPTER_CHARS = 2800;
const TTS_PARALLELISM = 4;
const GENERATING_MARKER = '__generating__';

function cleanText(input: string): string {
  return input
    .replace(/\r/g, '')
    .replace(/([a-zà-öø-ÿ])[-–]\n([a-zà-öø-ÿ])/gi, '$1$2')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n')
    .trim();
}

function wordsCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function guessTitle(text: string, fallback: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  return (
    lines.find(
      line =>
        line.length <= 100 &&
        /^(chapitre|chapter|partie|part|prologue|épilogue|epilogue|introduction|conclusion|préface|preface|avant-propos|interlude)\b/i.test(
          line
        )
    ) || fallback
  );
}

function splitForAudio(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean);
  const result: string[] = [];
  let current = '';

  const pushLong = (value: string) => {
    const sentences = value.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [value];
    let block = '';
    for (const sentence of sentences) {
      const candidate = `${block}${block ? ' ' : ''}${sentence.trim()}`;
      if (candidate.length > MAX_CHAPTER_CHARS && block) {
        result.push(block.trim());
        block = sentence.trim();
      } else {
        block = candidate;
      }
    }
    if (block.trim()) result.push(block.trim());
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHAPTER_CHARS) {
      if (current.trim()) result.push(current.trim());
      current = '';
      pushLong(paragraph);
      continue;
    }
    const candidate = `${current}${current ? '\n\n' : ''}${paragraph}`;
    if (candidate.length > MAX_CHAPTER_CHARS && current) {
      result.push(current.trim());
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) result.push(current.trim());
  return result.length ? result : [text.trim()].filter(Boolean);
}

function isAudioReady(record: ChapterRecord | null | undefined): boolean {
  return Boolean(record?.audioPath?.startsWith('cloud/'));
}

async function getJob(id: string): Promise<JobRecord | null> {
  const [job] = await db.get<JobRecord>(JOBS, [id]);
  return job;
}

async function updateJob(
  id: string,
  job: JobRecord,
  patch: Partial<JobRecord>
): Promise<JobRecord> {
  const updated: JobRecord = { ...job, ...patch, updatedAt: Date.now() };
  const [ok] = await db.update(JOBS, [{ id, record: { ...updated } }]);
  if (!ok) throw new Error('Impossible de mettre à jour le traitement.');
  return updated;
}

function partPath(jobId: string, index: number): string {
  return `cloud/${jobId}/parts/${String(index).padStart(6, '0')}.part`;
}

async function readStoredRange(
  jobId: string,
  begin: number,
  end: number,
  chunkSize: number
): Promise<Uint8Array> {
  const first = Math.floor(begin / chunkSize);
  const last = Math.floor(Math.max(begin, end - 1) / chunkSize);
  const paths: string[] = [];
  for (let index = first; index <= last; index += 1) {
    paths.push(partPath(jobId, index));
  }
  const files = await storage.read(paths);
  const pieces = files.map((file, offset) => {
    if (!file.content) throw new Error(`Bloc PDF manquant : ${first + offset}`);
    return Buffer.from(file.content, 'base64');
  });
  const startOffset = begin - first * chunkSize;
  const required = end - begin;
  const combined = Buffer.concat(pieces);
  return new Uint8Array(combined.subarray(startOffset, startOffset + required));
}

class StoredPdfRangeTransport extends PDFDataRangeTransport {
  private stopped = false;

  constructor(
    private readonly jobId: string,
    fileSize: number,
    private readonly chunkSize: number
  ) {
    super(fileSize, null, false, jobId);
  }

  requestDataRange(begin: number, end: number): void {
    if (this.stopped) return;
    void readStoredRange(this.jobId, begin, end, this.chunkSize)
      .then(bytes => {
        if (!this.stopped) {
          (
            this as unknown as {
              onDataRange: (start: number, chunk: Uint8Array) => void;
            }
          ).onDataRange(begin, bytes);
        }
      })
      .catch(err => console.error('pdf_range_read_failed', err));
  }

  abort(): void {
    this.stopped = true;
  }
}

function textFromItems(items: Array<unknown>): string {
  let result = '';
  for (const item of items) {
    if (typeof item === 'object' && item !== null && 'str' in item) {
      const typed = item as { str: string; hasEOL?: boolean };
      result += typed.str;
      result += typed.hasEOL ? '\n' : ' ';
    }
  }
  return cleanText(result);
}

async function persistChapterBlocks(
  jobId: string,
  job: JobRecord,
  text: string,
  pageStart: number,
  pageEnd: number
): Promise<JobRecord> {
  const cleaned = cleanText(text);
  if (!cleaned) return job;

  const blocks = splitForAudio(cleaned);
  if (!blocks.length) return job;

  const records = blocks.map((block, offset) => {
    const words = wordsCount(block);
    const fallback =
      pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}–${pageEnd}`;
    const record: ChapterRecord = {
      jobId,
      index: job.chapterIds.length + offset,
      title: guessTitle(
        block,
        blocks.length > 1 ? `${fallback} · ${offset + 1}` : fallback
      ),
      text: block,
      words,
      estimatedMinutes: Math.max(1, Math.round(words / 165)),
      pageStart,
      pageEnd,
      audioPath: '',
      audioMimeType: '',
      createdAt: Date.now(),
    };
    return record;
  });

  const ids = await db.add(CHAPTERS, records.map(record => ({ ...record })));
  const added = ids.filter((id): id is string => Boolean(id));
  if (added.length !== records.length) {
    throw new Error('Impossible d’enregistrer tous les chapitres.');
  }
  return { ...job, chapterIds: [...job.chapterIds, ...added] };
}

async function processJobBatch(
  jobId: string,
  sourceJob: JobRecord,
  maxPages = PROCESS_PAGES
): Promise<JobRecord> {
  let job = sourceJob;
  if (!['queued', 'processing', 'waiting_ocr'].includes(job.status)) return job;

  const transport = new StoredPdfRangeTransport(jobId, job.size, job.chunkSize);
  const loadingTask = getDocument({
    range: transport,
    rangeChunkSize: job.chunkSize,
    disableAutoFetch: true,
    disableStream: true,
  });

  try {
    const pdf = await loadingTask.promise;
    const pages = job.pages || pdf.numPages;
    let pageNumber = Math.max(1, job.nextPage || 1);
    let batchStartPage = pageNumber;
    const texts: string[] = [];
    let processed = 0;

    while (pageNumber <= pages && processed < maxPages) {
      const page = await pdf.getPage(pageNumber);
      let pageText = '';
      try {
        const content = await page.getTextContent();
        pageText = textFromItems(content.items as Array<unknown>);
      } finally {
        page.cleanup();
      }

      const hasRealText = pageText.replace(/\s/g, '').length >= 60;
      if (hasRealText) {
        if (!texts.length) batchStartPage = pageNumber;
        texts.push(pageText);
      }

      // Les images, illustrations et pages scannées sans vraie couche texte sont ignorées.
      pageNumber += 1;
      processed += 1;
    }

    if (texts.length) {
      job = await persistChapterBlocks(
        jobId,
        job,
        texts.join('\n\n'),
        batchStartPage,
        pageNumber - 1
      );
    }

    const finished = pageNumber > pages;
    return updateJob(jobId, job, {
      pages,
      nextPage: pageNumber,
      status: finished ? 'text_ready' : 'processing',
      needsOcrPage: null,
      error: '',
    });
  } finally {
    transport.abort();
    await loadingTask.destroy().catch(() => undefined);
  }
}

function configuredProvider(): 'deepinfra' | 'gemini' | '' {
  if (process.env.DEEPINFRA_API_KEY) return 'deepinfra';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return '';
}

async function deepInfraTts(
  text: string
): Promise<{ base64: string; mimeType: string; extension: string }> {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error('Clé DeepInfra absente.');

  const response = await fetch(
    'https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M',
    {
      method: 'POST',
      headers: {
        Authorization: `bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        tts_response_format: 'mp3',
        preset_voice: ['ff_siwis'],
        speed: 1,
        stream: false,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`DeepInfra TTS ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as { audio?: string };
  if (!payload.audio) throw new Error('DeepInfra n’a renvoyé aucun audio.');

  if (/^https?:\/\//.test(payload.audio)) {
    const audioResponse = await fetch(payload.audio);
    if (!audioResponse.ok) {
      throw new Error('Impossible de récupérer l’audio DeepInfra.');
    }
    return {
      base64: Buffer.from(await audioResponse.arrayBuffer()).toString('base64'),
      mimeType: 'audio/mpeg',
      extension: 'mp3',
    };
  }

  const base64 = payload.audio.includes(',')
    ? payload.audio.slice(payload.audio.indexOf(',') + 1)
    : payload.audio;
  return { base64, mimeType: 'audio/mpeg', extension: 'mp3' };
}

async function geminiTts(
  text: string
): Promise<{ base64: string; mimeType: string; extension: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Clé Gemini absente.');

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-lite-tts',
        input: [
          {
            type: 'user_input',
            content: [
              {
                type: 'text',
                text,
                annotations: [
                  {
                    type: 'speech_metadata',
                    style:
                      'Narration de livre audio naturelle, chaleureuse, claire et régulière en français.',
                  },
                ],
              },
            ],
          },
        ],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: 'Kore' }] },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini TTS ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    steps?: Array<{
      type?: string;
      content?: Array<{ type?: string; data?: string; mime_type?: string }>;
    }>;
  };
  const audio = payload.steps
    ?.flatMap(step => step.content ?? [])
    .filter(content => content.type === 'audio')
    .at(-1);

  if (!audio?.data) throw new Error('Gemini n’a renvoyé aucun audio.');
  return {
    base64: audio.data,
    mimeType: audio.mime_type || 'audio/wav',
    extension: 'wav',
  };
}

async function generateAudioBatch(
  jobId: string,
  sourceJob: JobRecord,
  limit = TTS_PARALLELISM
): Promise<JobRecord> {
  const provider = configuredProvider();
  if (!provider || !sourceJob.chapterIds.length) return sourceJob;

  const chapterRecords = await db.get<ChapterRecord>(
    CHAPTERS,
    sourceJob.chapterIds
  );

  const pending = chapterRecords
    .map((chapter, index) => ({
      chapter,
      index,
      chapterId: sourceJob.chapterIds[index],
    }))
    .filter(
      item =>
        item.chapter &&
        !isAudioReady(item.chapter) &&
        item.chapter.audioPath !== GENERATING_MARKER
    )
    .slice(0, Math.max(1, limit));

  if (!pending.length) {
    const readyCount = chapterRecords.filter(isAudioReady).length;
    const allTextReady =
      sourceJob.pages > 0 && sourceJob.nextPage > sourceJob.pages;
    const allAudioReady =
      allTextReady && readyCount >= sourceJob.chapterIds.length;
    return updateJob(jobId, sourceJob, {
      audioReady: readyCount,
      status: allAudioReady
        ? 'complete'
        : allTextReady
          ? 'generating_audio'
          : sourceJob.status,
    });
  }

  const claims = await db.update(
    CHAPTERS,
    pending.map(({ chapter, chapterId }) => ({
      id: chapterId,
      record: {
        ...chapter!,
        audioPath: GENERATING_MARKER,
        audioMimeType: '',
      },
    }))
  );

  const claimed = pending.filter((_, index) => claims[index]);

  const results = await Promise.allSettled(
    claimed.map(async ({ chapter, index, chapterId }) => {
      const current = chapter!;
      try {
        const audio =
          provider === 'deepinfra'
            ? await deepInfraTts(current.text)
            : await geminiTts(current.text);
        const path = `cloud/${jobId}/audio/${String(index).padStart(5, '0')}.${audio.extension}`;
        const [written] = await storage.write([
          { path, content: audio.base64, contentType: audio.mimeType },
        ]);
        if (!written) {
          throw new Error(`Impossible de stocker l’audio ${index + 1}.`);
        }
        const [updated] = await db.update(CHAPTERS, [
          {
            id: chapterId,
            record: {
              ...current,
              audioPath: path,
              audioMimeType: audio.mimeType,
            },
          },
        ]);
        if (!updated) {
          throw new Error(`Impossible d’enregistrer l’audio ${index + 1}.`);
        }
      } catch (err) {
        await db.update(CHAPTERS, [
          {
            id: chapterId,
            record: { ...current, audioPath: '', audioMimeType: '' },
          },
        ]);
        throw err;
      }
    })
  );

  const refreshed = await db.get<ChapterRecord>(
    CHAPTERS,
    sourceJob.chapterIds
  );
  const audioReady = refreshed.filter(isAudioReady).length;
  const allTextReady =
    sourceJob.pages > 0 && sourceJob.nextPage > sourceJob.pages;
  const allAudioReady =
    allTextReady && audioReady >= sourceJob.chapterIds.length;

  const updatedJob = await updateJob(jobId, sourceJob, {
    audioReady,
    status: allAudioReady
      ? 'complete'
      : allTextReady
        ? 'generating_audio'
        : sourceJob.status,
  });

  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed && audioReady === sourceJob.audioReady) throw failed.reason;

  return updatedJob;
}

async function publicJob(jobId: string, job: JobRecord) {
  const records = job.chapterIds.length
    ? await db.get<ChapterRecord>(CHAPTERS, job.chapterIds)
    : [];

  const audioPaths = records.flatMap(record =>
    isAudioReady(record) && record?.audioPath ? [record.audioPath] : []
  );
  const signed = audioPaths.length ? await storage.url(audioPaths) : [];
  const urlMap = new Map(signed.map(item => [item.path, item.url]));

  const chapters = records.flatMap((record, index) =>
    record
      ? [
          {
            id: job.chapterIds[index],
            title: record.title,
            text: record.text,
            words: record.words,
            estimatedMinutes: record.estimatedMinutes,
            pageStart: record.pageStart,
            pageEnd: record.pageEnd,
            audioUrl: isAudioReady(record)
              ? urlMap.get(record.audioPath)
              : undefined,
            audioMimeType: isAudioReady(record)
              ? record.audioMimeType || undefined
              : undefined,
          },
        ]
      : []
  );

  const provider = configuredProvider();
  return {
    id: jobId,
    title: job.title,
    name: job.name,
    size: job.size,
    status: job.status,
    pages: job.pages,
    nextPage: job.nextPage,
    processingProgress: job.pages
      ? Math.min(
          100,
          Math.round(
            ((Math.min(job.nextPage, job.pages + 1) - 1) / job.pages) * 100
          )
        )
      : 0,
    audioReady: job.audioReady,
    ttsConfigured: Boolean(provider),
    ttsProvider: provider || 'local-fallback',
    needsOcrPage: null,
    error: job.error || undefined,
    chapters,
  };
}

async function statusResponse(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return error('Traitement introuvable.', 404);
  return json(await publicJob(jobId, job));
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],

  'GET /api/cloud/capabilities': [
    async () =>
      json({
        cloud: true,
        chunkUpload: true,
        ocr: false,
        ttsConfigured: Boolean(configuredProvider()),
        ttsProvider: configuredProvider() || 'local-fallback',
      }),
  ],

  'POST /api/cloud/jobs': [
    async ({ body }) => {
      const input = body as {
        name?: string;
        title?: string;
        size?: number;
        mimeType?: string;
      };
      if (!input.name || !input.size || input.size <= 0) {
        return error('Fichier PDF invalide.', 400);
      }

      const totalParts = Math.ceil(input.size / UPLOAD_CHUNK_SIZE);
      const record: JobRecord = {
        title: input.title || input.name.replace(/\.pdf$/i, ''),
        name: input.name,
        size: input.size,
        mimeType: input.mimeType || 'application/pdf',
        chunkSize: UPLOAD_CHUNK_SIZE,
        totalParts,
        status: 'uploading',
        pages: 0,
        nextPage: 1,
        chapterIds: [],
        audioReady: 0,
        needsOcrPage: null,
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const [id] = await db.add(JOBS, [{ ...record }]);
      if (!id) return error('Impossible de créer la tâche.', 500);
      return json({ id, chunkSize: UPLOAD_CHUNK_SIZE, totalParts });
    },
  ],

  'POST /api/cloud/jobs/:id/chunk': [
    async ({ params, body }) => {
      const job = await getJob(params.id);
      if (!job) return error('Tâche introuvable.', 404);

      const input = body as { index?: number; data?: string };
      if (
        !Number.isInteger(input.index) ||
        !input.data ||
        (input.index as number) < 0 ||
        (input.index as number) >= job.totalParts
      ) {
        return error('Bloc invalide.', 400);
      }

      const [ok] = await storage.write([
        {
          path: partPath(params.id, input.index as number),
          content: input.data,
          contentType: 'application/octet-stream',
        },
      ]);
      if (!ok) return error('Échec de stockage du bloc.', 500);
      return json({ ok: true, index: input.index });
    },
  ],

  'POST /api/cloud/jobs/:id/complete': [
    async ({ params }) => {
      const job = await getJob(params.id);
      if (!job) return error('Tâche introuvable.', 404);

      const checks = await storage.read([
        partPath(params.id, 0),
        partPath(params.id, Math.max(0, job.totalParts - 1)),
      ]);
      if (checks.some(item => !item.content)) {
        return error('Le transfert est incomplet. Relance l’import.', 409);
      }

      const updated = await updateJob(params.id, job, {
        status: 'queued',
        error: '',
      });
      return json(await publicJob(params.id, updated));
    },
  ],

  'GET /api/cloud/jobs/:id': [async ({ params }) => statusResponse(params.id)],

  'POST /api/cloud/jobs/:id/process-next': [
    async ({ params }) => {
      const job = await getJob(params.id);
      if (!job) return error('Tâche introuvable.', 404);

      try {
        let updated = await processJobBatch(params.id, job);

        // Dès qu'un premier bloc de texte existe, on génère immédiatement son audio.
        if (
          configuredProvider() &&
          updated.chapterIds.length > updated.audioReady
        ) {
          const limit = updated.status === 'text_ready' ? TTS_PARALLELISM : 1;
          updated = await generateAudioBatch(params.id, updated, limit);
        }

        return json(await publicJob(params.id, updated));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Erreur de lecture du PDF.';
        const protectedPdf = /password|mot de passe/i.test(message);
        const failed = await updateJob(params.id, job, {
          status: protectedPdf ? 'password_protected' : 'failed',
          error: message,
        });
        console.error('pdf_process_failed', err);
        return json(await publicJob(params.id, failed));
      }
    },
  ],

  // Conservé pour compatibilité avec d'anciens clients, mais volontairement désactivé.
  'POST /api/cloud/jobs/:id/ocr-page': [
    async () => error('Analyse d’image désactivée : LivreVox lit uniquement le texte du PDF.', 410),
  ],

  'POST /api/cloud/jobs/:id/tts-next': [
    async ({ params }) => {
      const job = await getJob(params.id);
      if (!job) return error('Tâche introuvable.', 404);
      if (!configuredProvider()) return json(await publicJob(params.id, job));

      try {
        const updated = await generateAudioBatch(
          params.id,
          job,
          TTS_PARALLELISM
        );
        return json(await publicJob(params.id, updated));
      } catch (err) {
        console.error('tts_failed', err);
        return error(
          err instanceof Error ? err.message : 'Génération audio impossible.',
          502
        );
      }
    },
  ],

  'DELETE /api/cloud/jobs/:id': [
    async ({ params }) => {
      const job = await getJob(params.id);
      if (!job) return json({ deleted: true });

      const chapterRecords = job.chapterIds.length
        ? await db.get<ChapterRecord>(CHAPTERS, job.chapterIds)
        : [];
      const paths: string[] = [];

      for (let index = 0; index < job.totalParts; index += 1) {
        paths.push(partPath(params.id, index));
      }
      chapterRecords.forEach(record => {
        if (isAudioReady(record) && record?.audioPath) paths.push(record.audioPath);
      });

      for (let start = 0; start < paths.length; start += 100) {
        await storage.delete(paths.slice(start, start + 100));
      }
      if (job.chapterIds.length) await db.delete(CHAPTERS, job.chapterIds);
      await db.delete(JOBS, [params.id]);
      return json({ deleted: true });
    },
  ],
});

export const cloudWorker = async () => {
  const { items } = await db.list<JobRecord>(JOBS, { limit: 20 });
  const active = items
    .filter(job =>
      ['queued', 'processing', 'text_ready', 'generating_audio'].includes(
        job.status
      )
    )
    .slice(0, 3);

  for (const item of active) {
    const { id, ...jobData } = item;
    let job = jobData as JobRecord;
    try {
      if (['queued', 'processing', 'waiting_ocr'].includes(job.status)) {
        job = await processJobBatch(id, job, PROCESS_PAGES);
      }
      if (configuredProvider() && job.chapterIds.length > job.audioReady) {
        const limit = job.status === 'text_ready' ? TTS_PARALLELISM : 1;
        await generateAudioBatch(id, job, limit);
      }
    } catch (err) {
      console.error('worker_job_failed', id, err);
    }
  }

  return { statusCode: 200 };
};
