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
  loadingTask.onPassword = (updatePassword, reason) => {
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
      const viewport = page.getViewport({ scale: 1.2 });
      canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Impossible de préparer la page.');
      await page.render({ canvasContext: context, viewport }).promise;
      return await new Promise<Blob>((resolve, reject) =>
        canvas!.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('Impossible de convertir la page en image.')),
          'image/jpeg',
          0.8
        )
      );
    } finally {
      page.cleanup();
    }
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    rangeTransport.abort();
    await loadingTask.destroy().catch(() => undefined);
  }
}

export async function extractPdf(
  file: File,
  options: PdfOptions,
  onProgress: (progress: ImportProgress) => void
): Promise<PdfResult> {
  onProgress({ stage: 'Ouverture du PDF', progress: 2 });
  const rangeTransport = new LocalFileRangeTransport(file);
  const loadingTask = pdfjsLib.getDocument({
    range: rangeTransport,
    rangeChunkSize: 1024 * 1024,
    disableAutoFetch: true,
    disableStream: true,
  });

  loadingTask.onProgress = progress => {
    if (!progress.total) return;
    const ratio = Math.max(0, Math.min(1, progress.loaded / progress.total));
    onProgress({
      stage: 'Lecture du document',
      progress: Math.max(2, Math.min(7, Math.round(ratio * 7))),
    });
  };

  loadingTask.onPassword = (updatePassword, reason) => {
    void (async () => {
      const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const password = options.requestPassword
        ? await options.requestPassword(incorrect)
        : null;
      if (password) updatePassword(password);
      else updatePassword(new Error('Ouverture du PDF annulée.'));
    })();
  };

  const pageTexts: string[] = [];

  try {
    const pdfDocument = await loadingTask.promise;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = textFromContent(content.items as Array<unknown>);

        // LivreVox lit uniquement le vrai texte du PDF.
        // Les images, illustrations et pages scannées sans couche texte sont ignorées.
        if (pageText.replace(/\s/g, '').length >= 20) {
          pageTexts.push(pageText);
        }

        onProgress({
          stage: `Lecture de la page ${pageNumber}/${pdfDocument.numPages}`,
          progress: 8 + Math.round((pageNumber / pdfDocument.numPages) * 84),
        });
      } finally {
        page.cleanup();
      }
    }

    onProgress({
      stage: 'Création des chapitres',
      progress: 95,
    });

    return {
      text: pageTexts.join('\n\n'),
      pages: pdfDocument.numPages,
      ocrUsed: false,
    };
  } finally {
    rangeTransport.abort();
    await loadingTask.destroy().catch(() => undefined);
  }
}
