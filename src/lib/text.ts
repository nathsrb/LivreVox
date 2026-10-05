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

function isHeading(line: string): boolean {
  const value = line.trim();
  if (!value || value.length > 110) return false;
  return (
    /^(chapitre|chapter|partie|part|prologue|épilogue|epilogue|introduction|conclusion|préface|preface|avant-propos|interlude)\b[\s\d:—–.-]*/i.test(
      value
    ) ||
    /^\d{1,3}[.)-]\s+[A-ZÀ-ÖØ-Ý]/.test(value) ||
    (/^[A-ZÀ-ÖØ-Ý0-9][A-ZÀ-ÖØ-Ý0-9 '\-–—,:]{3,70}$/.test(value) &&
      value.split(/\s+/).length <= 10)
  );
}

function smartBlocks(text: string, targetChars = 11500): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  const result: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > targetChars) {
      result.push(current.trim());
      current = paragraph;
    } else {
      current += `${current ? '\n\n' : ''}${paragraph}`;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result.length ? result : [text.trim()];
}

export function splitIntoChapters(text: string): Chapter[] {
  const lines = text.split('\n');
  const headings = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => isHeading(line));

  if (headings.length >= 2) {
    const chapters: Chapter[] = [];
    if (headings[0].index > 2) {
      const intro = lines.slice(0, headings[0].index).join('\n').trim();
      if (intro.length > 160)
        chapters.push(makeChapter('Ouverture', intro, chapters.length));
    }
    headings.forEach((heading, headingIndex) => {
      const end =
        headingIndex + 1 < headings.length
          ? headings[headingIndex + 1].index
          : lines.length;
      const body = lines
        .slice(heading.index + 1, end)
        .join('\n')
        .trim();
      if (body.length > 60)
        chapters.push(makeChapter(heading.line, body, chapters.length));
    });
    if (chapters.length >= 2) return chapters;
  }

  return smartBlocks(text).map((block, index) =>
    makeChapter(`Chapitre ${index + 1}`, block, index)
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
