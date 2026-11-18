import './polyfills';
import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import tesseractWorkerUrl from 'tesseract.js/dist/worker.min.js?url';
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
  outlineChapters?: Array<{ title: string; text: string }>;
};

type PdfPasswordUpdater = (password: string | Error) => void;
type PdfProgress = { loaded: number; total: number };

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

async function createPdfLoadingTask(file: File) {
  // Pour les fichiers sous 60 Mo, charger directement les octets en mémoire
  // évite tout bogue de ReadableStream ou de RangeTransport sur Safari iOS
  if (file.size < 60 * 1024 * 1024) {
    const arrayBuffer = await file.arrayBuffer();
    return {
      task: pdfjsLib.getDocument({
        data: new Uint8Array(arrayBuffer),
        disableAutoFetch: true,
        disableStream: true,
      }),
      cleanup: () => {},
    };
  }

  const rangeTransport = new LocalFileRangeTransport(file);
  return {
    task: pdfjsLib.getDocument({
      range: rangeTransport,
      rangeChunkSize: 1024 * 1024,
      disableAutoFetch: true,
      disableStream: true,
    }),
    cleanup: () => {
      rangeTransport.abort();
    },
  };
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
  const { task: loadingTask, cleanup } = await createPdfLoadingTask(file);

  loadingTask.onPassword = (updatePassword: PdfPasswordUpdater, reason: number) => {
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
    if (pageNumber < 1 || pageNumber > pdf.numPages)
      throw new Error('Page PDF invalide.');
    const page = await pdf.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1.2 });
      canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Impossible de préparer la page.');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      return await new Promise<Blob>((resolve, reject) =>
        canvas!.toBlob(
          blob =>
            blob
              ? resolve(blob)
              : reject(new Error('Impossible de convertir la page en image.')),
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
    cleanup();
    await loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Recognize chapter numbers printed as "– 1 –" / "– 2 –" at the start
 * of a page. These are real chapter markers, not technical audio chunks.
 */
function sectionsFromPrintedChapterNumbers(
  pages: string[]
): Array<{ title: string; text: string }> | undefined {
  type Candidate = { number: number; page: number; title: string };
  const found: Candidate[] = [];
  for (let page = 0; page < pages.length; page++) {
    const start = (pages[page] || '').slice(0, 850);
    const match = /[–—-]\s*(\d{1,2})\s*[–—-]/.exec(start);
    if (!match || match.index > 160) continue;
    const number = Number(match[1]);
    if (number < 1 || number > 60) continue;
    const remainder = start.slice(match.index + match[0].length).trim();
    let title = remainder.split('\n').find(Boolean)?.trim() || '';
    title = title.replace(/\s+/g, ' ').trim();
    if (title.length < 4 || title.length > 100) title = 'Chapitre ' + number;
    found.push({ number, page, title });
  }

  // Accept only a consecutive sequence beginning at 1, on separate pages.
  const numbered: Candidate[] = [];
  for (const item of found) {
    if (item.number !== numbered.length + 1) continue;
    if (numbered.length && item.page - numbered[numbered.length - 1].page < 2) continue;
    numbered.push(item);
  }
  if (numbered.length < 3 || numbered.length > 50) return undefined;

  const chapters: Array<{ title: string; text: string }> = [];
  for (let i = 0; i < numbered.length; i++) {
    const current = numbered[i];
    const until = numbered[i + 1]?.page ?? pages.length;
    const body = pages.slice(current.page, until).join('\n\n').trim();
    if (body.length >= 250) chapters.push({ title: current.title, text: body });
  }
  return chapters.length === numbered.length ? chapters : undefined;
}

/**
 * Recover actual chapter boundaries from a PDF's built-in bookmarks.
 * PDF bookmarks are author metadata, unlike arbitrary reading-size chunks.
 * Reject suspicious outlines containing every page/paragraph.
 */
async function sectionsFromOutline(
  pdfDocument: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>,
  pageTexts: string[]
): Promise<Array<{ title: string; text: string }> | undefined> {
  try {
    const outline = await pdfDocument.getOutline();
    if (!outline?.length) return undefined;
    const top = outline;
    const child = top.flatMap(item => item.items || []);
    const candidates = [top, child].filter(items => items.length >= 2 && items.length <= 55);

    for (const items of candidates) {
      const pageEntries: Array<{ page: number; title: string }> = [];
      for (const item of items) {
        const dest = typeof item.dest === 'string'
          ? await pdfDocument.getDestination(item.dest)
          : item.dest;
        if (!dest?.length) continue;
        const ref = dest[0];
        const page = typeof ref === 'number' ? ref : await pdfDocument.getPageIndex(ref);
        if (!Number.isInteger(page) || page < 0 || page >= pdfDocument.numPages) continue;
        const title = item.title?.replace(/\s+/g, ' ').trim() || '';
        if (!title || /^page\s+\d+$/i.test(title)) continue;
        pageEntries.push({ page, title });
      }
      pageEntries.sort((a, b) => a.page - b.page);
      const unique = pageEntries.filter((item, index) => !index || item.page > pageEntries[index - 1].page);
      const maxChapters = Math.min(50, Math.max(8, Math.floor(pdfDocument.numPages / 4)));
      if (unique.length < 2 || unique.length > maxChapters) continue;
      const pageGaps = unique.slice(1).map((item, i) => item.page - unique[i].page);
      const tinyGaps = pageGaps.filter(gap => gap < 2).length;
      if (tinyGaps > Math.max(1, Math.floor(pageGaps.length * 0.2))) continue;

      const sections: Array<{ title: string; text: string }> = [];
      if (unique[0].page > 0) {
        const intro = pageTexts.slice(0, unique[0].page).join('\n\n').trim();
        if (intro.length > 200) sections.push({ title: 'Pages préliminaires', text: intro });
      }
      for (let i = 0; i < unique.length; i++) {
        const current = unique[i];
        const next = unique[i + 1]?.page ?? pageTexts.length;
        const chapterText = pageTexts.slice(current.page, next).join('\n\n').trim();
        if (chapterText.length >= 200) sections.push({ title: current.title, text: chapterText });
      }
      if (sections.length >= 2) return sections;
    }
  } catch (error) {
    console.warn('Sommaire PDF non exploitable, analyse des vrais titres du texte.', error);
  }
  return undefined;
}


/**
 * A scanned PDF page can contain two facing book pages. Keep their reading
 * order (left then right) before trying to find chapters in the OCR output.
 * Chapters are inferred only from headings at the TOP of a physical page.
 */
function sectionsFromScannedPages(
  physicalPages: string[]
): Array<{ title: string; text: string }> | undefined {
  type Heading = { index: number; title: string; number?: number };
  const structural: Heading[] = [];
  const numbered: Heading[] = [];
  const romanNumber = (value: string): number => {
    const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
    let total = 0;
    const upper = value.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const current = values[upper[i]] || 0;
      const next = values[upper[i + 1]] || 0;
      total += current < next ? -current : current;
    }
    return total;
  };

  physicalPages.forEach((text, index) => {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 7);
    if (lines.length < 2) return;
    const chapterAt = lines.findIndex((line, position) =>
      position < 3 && /^(?:chapitre|chapter)\b(?:\s+(?:\d{1,2}|[IVXL]{1,7}))?\s*[.:–-]?$/i.test(line)
    );
    if (chapterAt !== -1) {
      const label = lines[chapterAt];
      const next = (lines[chapterAt + 1] || '').replace(/\s+/g, ' ');
      const title = next.length >= 4 && next.length <= 95
        ? label + ' — ' + next
        : label;
      structural.push({ index, title });
      return;
    }

    const first = lines[0].replace(/[.]/g, '').trim();
    const marker = /^(\d{1,2}|[IVXL]{1,7})$/i.exec(first);
    if (!marker) return;
    const number = /^\d+$/.test(first) ? Number(first) : romanNumber(first);
    const title = lines[1].replace(/\s+/g, ' ').trim();
    if (number < 1 || number > 60 || title.length < 4 || title.length > 90) return;
    // Page-number headers are not book chapters: only accept a consecutive
    // sequence starting at chapter 1, and spaced across multiple pages.
    numbered.push({ index, number, title: 'Chapitre ' + number + ' — ' + title });
  });

  let headings = structural;
  if (headings.length < 2) {
    const sequence: Heading[] = [];
    for (const candidate of numbered) {
      if (candidate.number !== sequence.length + 1) continue;
      if (sequence.length && candidate.index - sequence[sequence.length - 1].index < 2) continue;
      sequence.push(candidate);
    }
    headings = sequence.length >= 3 ? sequence : [];
  }
  if (headings.length < 2 || headings.length > 60) return undefined;

  const sections: Array<{ title: string; text: string }> = [];
  const intro = physicalPages.slice(0, headings[0].index).join('\n\n').trim();
  if (intro.length >= 200) sections.push({ title: 'Pages préliminaires', text: intro });
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.index ?? physicalPages.length;
    const text = physicalPages.slice(heading.index, end).join('\n\n').trim();
    if (text.length >= 200) sections.push({ title: heading.title, text });
  });
  return sections.length >= 2 ? sections : undefined;
}

export async function extractPdf(
  file: File,
  options: PdfOptions,
  onProgress: (progress: ImportProgress) => void
): Promise<PdfResult> {
  onProgress({ stage: 'Ouverture du PDF', progress: 2 });
  const { task: loadingTask, cleanup } = await createPdfLoadingTask(file);

  loadingTask.onProgress = (progress: PdfProgress) => {
    if (!progress.total) return;
    const ratio = Math.max(0, Math.min(1, progress.loaded / progress.total));
    onProgress({
      stage: 'Lecture du document',
      progress: Math.max(2, Math.min(7, Math.round(ratio * 7))),
    });
  };

  loadingTask.onPassword = (updatePassword: PdfPasswordUpdater, reason: number) => {
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
  const physicalPages: string[] = [];
  let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
  let ocrUsed = false;

  try {
    const pdfDocument = await loadingTask.promise;
    // Preserve PDF page indices for bookmark-based chapter boundaries.
    pageTexts.length = pdfDocument.numPages;
    pageTexts.fill('');

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = textFromContent(content.items as Array<unknown>);
        if (pageText.replace(/\s/g, '').length >= 20) {
          pageTexts[pageNumber - 1] = pageText;
          physicalPages.push(pageText);
        } else if (options.autoOcr) {
          // Start Tesseract only if this document actually contains scans.
          // Its recognition worker runs on the reader's device, not Netlify.
          if (!ocrWorker) {
            onProgress({
              stage: 'Initialisation de la reconnaissance des pages scannées',
              progress: 8 + Math.round(((pageNumber - 1) / pdfDocument.numPages) * 84),
            });
            try {
              ocrWorker = await createWorker(options.ocrLang, 1, {
                workerPath: tesseractWorkerUrl,
                workerBlobURL: false,
              });
            } catch (error) {
              console.error('OCR: initialisation impossible', error);
              throw new Error('Impossible de lancer la lecture des pages scannées. Vérifie ta connexion Internet pour télécharger le modèle de reconnaissance du français, puis réessaie.');
            }
          }

          const normalViewport = page.getViewport({ scale: 1 });
          // Render at a useful OCR resolution without exhausting mobile RAM.
          const scale = Math.min(3.5, Math.max(1.7, 1800 / normalViewport.width));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);

          try {
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) throw new Error('La mémoire disponible ne permet pas de lire cette page scannée.');
            await page.render({ canvas, canvasContext: context, viewport }).promise;

            const spread = normalViewport.width > normalViewport.height * 1.18;
            const panelCount = spread ? 2 : 1;
            const recognizedPanels: string[] = [];

            for (let panelIndex = 0; panelIndex < panelCount; panelIndex += 1) {
              onProgress({
                stage: 'Reconnaissance du texte · PDF ' + pageNumber + '/' + pdfDocument.numPages +
                  (spread ? (panelIndex === 0 ? ' · page gauche' : ' · page droite') : ''),
                progress: 8 + Math.round(
                  ((pageNumber - 1 + (panelIndex + 0.5) / panelCount) / pdfDocument.numPages) * 84
                ),
              });

              let inputCanvas = canvas;
              if (spread) {
                const left = panelIndex === 0 ? 0 : Math.floor(canvas.width / 2);
                const right = panelIndex === 0 ? Math.floor(canvas.width / 2) : canvas.width;
                const panelCanvas = document.createElement('canvas');
                panelCanvas.width = right - left;
                panelCanvas.height = canvas.height;
                const panelContext = panelCanvas.getContext('2d', { alpha: false });
                if (!panelContext) throw new Error('Impossible de découper la double page scannée.');
                panelContext.drawImage(
                  canvas, left, 0, right - left, canvas.height,
                  0, 0, right - left, canvas.height
                );
                inputCanvas = panelCanvas;
              }

              try {
                const result = await ocrWorker.recognize(inputCanvas);
                const recognized = result.data.text.replace(/\u0000/g, '').trim();
                physicalPages.push(recognized);
                if (recognized) {
                  recognizedPanels.push(recognized);
                  ocrUsed = true;
                }
              } finally {
                if (inputCanvas !== canvas) {
                  inputCanvas.width = 0;
                  inputCanvas.height = 0;
                  inputCanvas.remove();
                }
              }
            }
            pageTexts[pageNumber - 1] = recognizedPanels.join('\n\n');
          } finally {
            canvas.width = 0;
            canvas.height = 0;
            canvas.remove();
          }
        } else {
          physicalPages.push('');
        }

        onProgress({
          stage: 'Lecture de la page ' + pageNumber + '/' + pdfDocument.numPages,
          progress: 8 + Math.round((pageNumber / pdfDocument.numPages) * 84),
        });
      } finally {
        page.cleanup();
      }
    }

    onProgress({ stage: 'Création des chapitres', progress: 95 });

    const outlineChapters =
      (ocrUsed ? sectionsFromScannedPages(physicalPages) : undefined) ??
      sectionsFromPrintedChapterNumbers(pageTexts) ??
      await sectionsFromOutline(pdfDocument, pageTexts);

    return {
      text: pageTexts.join('\n\n'),
      pages: pdfDocument.numPages,
      ocrUsed,
      outlineChapters,
    };
  } finally {
    if (ocrWorker) await ocrWorker.terminate().catch(() => undefined);
    cleanup();
    await loadingTask.destroy().catch(() => undefined);
  }
}
