import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ImportProgress } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfOptions = {
  autoOcr: boolean;
  ocrLang: 'fra' | 'eng' | 'fra+eng';
  requestPassword?: (incorrect: boolean) => Promise<string | null>;
};

type PdfResult = {
  text: string;
  pages: number;
  ocrUsed: boolean;
};

class LocalFileRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private readonly file: File;
  private aborted = false;

  constructor(file: File) {
    super(file.size, null, false, file.name);
    this.file = file;
  }

  requestDataRange(begin: number, end: number): void {
    if (this.aborted) return;
    void this.file
      .slice(begin, end)
      .arrayBuffer()
      .then(buffer => {
        if (!this.aborted) this.onDataRange(begin, new Uint8Array(buffer));
      })
      .catch(error => {
        console.error('Lecture locale du PDF impossible', error);
        if (!this.aborted) this.onDataRange(begin, null);
      });
  }

  abort(): void {
    this.aborted = true;
  }
}

function textFromContent(items: Array<unknown>): string {
  let result = '';
  for (const item of items) {
    if (typeof item === 'object' && item !== null && 'str' in item) {
      const typed = item as { str: string; hasEOL?: boolean };
      result += typed.str;
      result += typed.hasEOL ? '\n' : ' ';
    }
  }
  return result.trim();
}

export async function renderPdfPageImage(
  file: File,
  pageNumber: number,
  requestPassword?: (incorrect: boolean) => Promise<string | null>
): Promise<Blob> {
  const rangeTransport = new LocalFileRangeTransport(file);
  const loadingTask = pdfjsLib.getDocument({
    range: rangeTransport,
    rangeChunkSize: 1024 * 1024,
    disableAutoFetch: true,
    disableStream: true,
  });
  loadingTask.onPassword = (updatePassword: (password: string | Error) => void, reason: unknown) => {
    void (async () => {
      const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const password = requestPassword ? await requestPassword(incorrect) : null;
      if (password) updatePassword(password);
      else updatePassword(new Error('Ouverture du PDF annulée.'));
    })();
  };
  let canvas: HTMLCanvasElement | null = null;
  try {
    const pdf = await loadingTask.promise;
    if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error('Page PDF invalide.');
    const page = await pdf.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1.55 });
      canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Impossible de préparer la page pour l’OCR cloud.');
      await page.render({ canvasContext: context, viewport, canvas } as any).promise;
      return await new Promise<Blob>((resolve, reject) => canvas!.toBlob(blob => blob ? resolve(blob) : reject(new Error('Impossible de convertir la page en image.')), 'image/jpeg', 0.86));
    } finally {
      page.cleanup();
    }
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
    rangeTransport.abort();
    await loadingTask.destroy().catch(() => undefined);
  }
}

export async function extractPdf(
  file: File,
  options: PdfOptions,
  onProgress: (progress: ImportProgress) => void
): Promise<PdfResult> {
  onProgress({ stage: 'Ouverture du PDF par blocs', progress: 2 });
  const rangeTransport = new LocalFileRangeTransport(file);
  const loadingTask = pdfjsLib.getDocument({
    range: rangeTransport,
    rangeChunkSize: 1024 * 1024,
    disableAutoFetch: true,
    disableStream: true,
  });

  loadingTask.onProgress = (progress: { loaded: number; total: number }) => {
    if (!progress.total) return;
    const ratio = Math.max(0, Math.min(1, progress.loaded / progress.total));
    onProgress({
      stage: 'Lecture des données nécessaires',
      progress: Math.max(2, Math.min(7, Math.round(ratio * 7))),
    });
  };

  loadingTask.onPassword = (updatePassword: (password: string | Error) => void, reason: unknown) => {
    void (async () => {
      const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const password = options.requestPassword
        ? await options.requestPassword(incorrect)
        : null;
      if (password) {
        updatePassword(password);
      } else {
        updatePassword(new Error('Ouverture du PDF annulée.'));
      }
    })();
  };

  const pageTexts: string[] = [];
  let ocrUsed = false;
  let ocrWorker: Awaited<
    ReturnType<(typeof import('tesseract.js'))['createWorker']>
  > | null = null;

  try {
    const pdfDocument = await loadingTask.promise;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      let canvas: HTMLCanvasElement | null = null;

      try {
        const content = await page.getTextContent();
        let pageText = textFromContent(content.items as Array<unknown>);
        const shouldOcr =
          options.autoOcr && pageText.replace(/\s/g, '').length < 70;

        if (shouldOcr) {
          if (!ocrWorker) {
            onProgress({
              stage: 'Chargement de l’OCR local',
              progress: Math.max(
                8,
                Math.round((pageNumber / pdfDocument.numPages) * 70)
              ),
            });
            const { createWorker } = await import('tesseract.js');
            ocrWorker = await createWorker(options.ocrLang);
          }

          const viewport = page.getViewport({ scale: 1.55 });
          canvas = globalThis.document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d', { alpha: false });
          if (!context)
            throw new Error('Impossible de préparer cette page pour l’OCR.');

          await page.render({ canvasContext: context, viewport, canvas } as any).promise;
          const recognition = await ocrWorker.recognize(canvas);
          if (recognition.data.text.trim().length > pageText.trim().length)
            pageText = recognition.data.text.trim();
          ocrUsed = true;
        }

        pageTexts.push(pageText);
        onProgress({
          stage: shouldOcr
            ? `OCR de la page ${pageNumber}/${pdfDocument.numPages}`
            : `Lecture de la page ${pageNumber}/${pdfDocument.numPages}`,
          progress:
            8 + Math.round((pageNumber / pdfDocument.numPages) * 84),
        });
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
          canvas.remove();
        }
        page.cleanup();
      }
    }

    onProgress({
      stage: 'Nettoyage et création des chapitres',
      progress: 95,
    });
    return {
      text: pageTexts.join('\n\n'),
      pages: pdfDocument.numPages,
      ocrUsed,
    };
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    rangeTransport.abort();
    await loadingTask.destroy().catch(() => undefined);
  }
}
