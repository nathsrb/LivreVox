import type { Chapter } from '../types';

export function cleanExtractedText(input: string): string {
  return input
    .replace(/\r/g, '')
    .replace(/([a-zà-öø-ÿ])[-–]\n([a-zà-öø-ÿ])/gi, '$1$2')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(line => !/^\s*(page\s*)?\d{1,4}\s*$/i.test(line))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function wordsCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function makeChapter(title: string, text: string, index: number): Chapter {
  const words = wordsCount(text);
  return {
    id: crypto.randomUUID(),
    title: title.trim() || `Chapitre ${index + 1}`,
    text: text.trim(),
    words,
    estimatedMinutes: Math.max(1, Math.round(words / 165)),
  };
}

type HeadingKind = 'structural' | 'numbered';

function headingKind(raw: string): HeadingKind | null {
  const value = raw.trim();
  if (value.length < 3 || value.length > 100) return null;

  // Only genuine chapter/part labels count as structural headings.
  // In particular, ALL-CAPS paragraphs and numbered list items are not chapters.
  if (
    /^(?:chapitre|chapter)\s+(?:\d{1,3}|[IVXLCDM]+)(?:\b|\s|[:.\-–—])/i.test(value) ||
    /^(?:partie|part|livre)\s+(?:\d{1,3}|[IVXLCDM]+)(?:\b|\s|[:.\-–—])/i.test(value) ||
    /^(?:prologue|épilogue|epilogue|introduction|conclusion|préface|preface|avant-propos)(?:\s*[:.\-–—].{1,60})?$/i.test(value)
  ) return 'structural';

  // Number-only chapter titles are ambiguous in nonfiction books: accept
  // them only if the overall document has a plausible number and spacing.
  if (/^\d{1,2}[.)-]\s+[A-ZÀ-ÖØ-Ý][^.!?]{5,75}$/.test(value)) return 'numbered';
  return null;
}

export type PdfChapterSection = {
  title: string;
  text: string;
};

/**
 * Returns *real* chapters only. The 500-character chunks used by Gemini TTS
 * are a separate implementation detail; never expose them as book chapters.
 */
export function splitIntoChapters(text: string, outlined?: PdfChapterSection[]): Chapter[] {
  const source = text.trim();
  if (!source) return [];

  // Prefer the document's own PDF bookmarks when they identify chapter pages.
  // Don't split genuine chapters just because the audio generator has a smaller
  // technical limit.
  const trusted = (outlined || []).filter(section => section.text.trim().length >= 200);
  if (trusted.length >= 2 && trusted.length <= 60) {
    return trusted.map((section, index) => makeChapter(section.title, section.text, index));
  }

  const lines = source.split('\n');
  const candidates: Array<{ index: number; title: string; kind: HeadingKind; offset: number }> = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const title = line.trim();
    const kind = headingKind(title);
    if (kind) candidates.push({ index, title, kind, offset });
    offset += line.length + 1;
  });

  const maxDetected = Math.min(45, Math.max(6, Math.floor(source.length / 9000)));
  function isPlausible(headings: typeof candidates): boolean {
    if (headings.length < 2 || headings.length > maxDetected) return false;
    const gaps = headings.slice(1).map((h, i) => h.offset - headings[i].offset);
    const crowded = gaps.filter(gap => gap < 1600).length;
    if (crowded > Math.max(1, Math.floor(gaps.length * 0.15))) return false;
    return source.length / headings.length >= 6500;
  }

  // Ignore the table of contents, which often repeats every chapter title in
  // quick succession near the start of the book.
  const afterContents = candidates.filter(h => h.offset >= Math.min(65000, source.length * 0.045));
  const structural = afterContents.filter(h => h.kind === 'structural');
  const numbered = afterContents.filter(h => h.kind === 'numbered');
  const headings = isPlausible(structural)
    ? structural
    : isPlausible(numbered)
      ? numbered
      : [];

  if (headings.length) {
    const chapters: Chapter[] = [];
    const intro = lines.slice(0, headings[0].index).join('\n').trim();
    if (intro.length >= 500) chapters.push(makeChapter('Pages préliminaires', intro, chapters.length));

    headings.forEach((heading, headingIndex) => {
      const end = headings[headingIndex + 1]?.index ?? lines.length;
      const body = lines.slice(heading.index + 1, end).join('\n').trim();
      if (body.length >= 250) {
        chapters.push(makeChapter(heading.title, body, chapters.length));
      }
    });
    if (chapters.length >= 2) return chapters;
  }

  // Do not fabricate "85 chapters" from 14k-character audio chunks.
  // Preserve the full text and be transparent when original chapter boundaries
  // cannot be established confidently.
  return [makeChapter('Texte intégral — chapitres non détectés', source, 0)];
}

export function chunkForSpeech(text: string, maxChars = 650): string[] {
  const sentences = text
    .replace(/\n+/g, ' ')
    .match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      const words = sentence.split(/\s+/);
      let part = '';
      for (const word of words) {
        if (part && part.length + word.length + 1 > maxChars) {
          chunks.push(part.trim());
          part = word;
        } else {
          part += `${part ? ' ' : ''}${word}`;
        }
      }
      if (part) chunks.push(part.trim());
    } else if (current && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += `${current ? ' ' : ''}${sentence}`;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function sanitizeFileName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90) || 'livre-audio'
  );
}
