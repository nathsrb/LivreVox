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

function smartBlocks(text: string, targetChars = 14000): string[] {
  // Fallback sections have a bounded size, even if PDF extraction produces
  // huge paragraphs with no blank lines. This avoids enormous WAV buffers.
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const blocks: string[] = [];
  let current = '';

  function flush() {
    if (current.trim()) blocks.push(current.trim());
    current = '';
  }

  for (const paragraph of paragraphs) {
    let remaining = paragraph;
    while (remaining.length > targetChars) {
      flush();
      let cut = remaining.lastIndexOf('. ', targetChars);
      if (cut < targetChars / 2) cut = remaining.lastIndexOf(' ', targetChars);
      if (cut < targetChars / 2) cut = targetChars;
      const first = remaining.slice(0, cut).trim();
      if (first) blocks.push(first);
      remaining = remaining.slice(cut).trim();
    }
    if (!remaining) continue;
    if (current && current.length + remaining.length + 2 > targetChars) flush();
    current += `${current ? '\n\n' : ''}${remaining}`;
  }
  flush();
  return blocks;
}

export function splitIntoChapters(text: string): Chapter[] {
  const source = text.trim();
  if (!source) return [];

  const lines = source.split('\n');
  const candidates: Array<{ index: number; title: string; kind: HeadingKind; offset: number }> = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const title = line.trim();
    const kind = headingKind(title);
    if (kind) candidates.push({ index, title, kind, offset });
    offset += line.length + 1;
  });

  // A normal book should not have hundreds of structural headings. If PDF
  // noise generates hundreds of candidates, reject them and group paragraphs
  // into balanced, meaningful reading sections instead.
  const maxDetected = Math.min(90, Math.max(8, Math.floor(source.length / 4000)));

  function isPlausible(headings: typeof candidates): boolean {
    if (headings.length < 2 || headings.length > maxDetected) return false;
    const gaps = headings.slice(1).map((h, i) => h.offset - headings[i].offset);
    const crowded = gaps.filter(gap => gap < 1300).length;
    if (crowded > Math.max(1, Math.floor(gaps.length * 0.2))) return false;
    return source.length / headings.length >= 3500;
  }

  const structural = candidates.filter(h => h.kind === 'structural');
  const numbered = candidates.filter(h => h.kind === 'numbered');
  const headings = isPlausible(structural)
    ? structural
    : isPlausible(numbered)
      ? numbered
      : [];

  if (headings.length) {
    const chapters: Chapter[] = [];
    const intro = lines.slice(0, headings[0].index).join('\n').trim();
    if (intro.length >= 500) {
      smartBlocks(intro).forEach((part, i) =>
        chapters.push(makeChapter(i ? `Ouverture · partie ${i + 1}` : 'Ouverture', part, chapters.length))
      );
    }

    headings.forEach((heading, headingIndex) => {
      const end = headings[headingIndex + 1]?.index ?? lines.length;
      const body = lines.slice(heading.index + 1, end).join('\n').trim();
      if (body.length < 250) return;
      smartBlocks(body).forEach((part, partIndex) => {
        const name = partIndex ? `${heading.title} · partie ${partIndex + 1}` : heading.title;
        chapters.push(makeChapter(name, part, chapters.length));
      });
    });
    if (chapters.length >= 2) return chapters;
  }

  // Clearly label fallback divisions as audio parts, not original chapters.
  return smartBlocks(source).map((part, index) =>
    makeChapter(`Partie audio ${index + 1}`, part, index)
  );
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
