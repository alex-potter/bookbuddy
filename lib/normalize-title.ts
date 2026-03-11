const LOWERCASE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor',
  'on', 'at', 'to', 'by', 'in', 'of', 'up', 'as', 'vs', 'via',
]);

export function normalizeTitle(raw: string): string {
  const t = raw.trim();
  const letters = t.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return t;
  const upperRatio = (letters.match(/[A-Z]/g) ?? []).length / letters.length;
  if (upperRatio < 0.5) return t;
  return t.toLowerCase().replace(/\b\w+/g, (word, offset) => {
    if (offset > 0 && LOWERCASE_WORDS.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}
