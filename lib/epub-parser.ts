import type { EbookChapter, ParsedEbook } from '@/types';

// Runs entirely in the browser using JSZip
export async function parseEpub(file: File): Promise<ParsedEbook> {
  const JSZip = (await import('jszip')).default;
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  // 1. Read container.xml to find the OPF file path
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('Invalid EPUB: missing META-INF/container.xml');

  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfMatch) throw new Error('Invalid EPUB: cannot find OPF path in container.xml');
  const opfPath = opfMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Parse OPF for metadata + manifest + spine
  const opfXml = await zip.file(opfPath)?.async('text');
  if (!opfXml) throw new Error('Invalid EPUB: missing OPF file');

  const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  const authorMatch = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  const title = titleMatch?.[1]?.trim() || file.name.replace('.epub', '');
  const author = authorMatch?.[1]?.trim() || 'Unknown Author';

  // Build manifest: id → href
  const manifestItems: Record<string, string> = {};
  for (const match of opfXml.matchAll(/<item\s[^>]*>/gi)) {
    const tag = match[0];
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const href = tag.match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) manifestItems[id] = href;
  }

  // Spine: ordered list of idref
  const spineMatches = [...opfXml.matchAll(/<itemref\s[^>]*idref="([^"]+)"[^>]*\/?>/gi)];

  // 3. Build a title map from NCX or EPUB3 nav before processing chapters
  const ncxTitleMap = await buildNcxTitleMap(zip, opfDir, opfXml);

  // 4. Extract chapter text in spine order
  const chapters: EbookChapter[] = [];
  let order = 0;

  for (const spineMatch of spineMatches) {
    const itemId = spineMatch[1];
    const href = manifestItems[itemId];
    if (!href) continue;

    // Try both with and without the OPF directory prefix
    const candidates = [opfDir + href, href, href.replace(/^.*\//, '')];
    let html: string | null = null;
    for (const path of candidates) {
      const decoded = decodeURIComponent(path);
      const entry = zip.file(path) || zip.file(decoded);
      if (entry) {
        html = await entry.async('text');
        break;
      }
    }
    if (!html) continue;

    const text = extractText(html);
    if (text.trim().length < 100) continue; // skip nav/toc/empty files

    // Title resolution priority:
    // 1. NCX/nav label (most reliable — editor-provided)
    // 2. First h1-h3 heading in the HTML
    // 3. Extended heading scan (h4-h6, bold paragraphs, title-classed elements)
    // 4. "Part N" fallback
    const basename = href.split('/').pop()!;
    const ncxTitle = ncxTitleMap.get(basename) ?? ncxTitleMap.get(href);
    let chapterTitle: string;
    if (ncxTitle) {
      chapterTitle = ncxTitle;
    } else {
      const headingMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      const rawTitle = headingMatch?.[1] ? extractText(headingMatch[1]) : '';
      if (rawTitle.trim()) {
        chapterTitle = rawTitle.trim();
      } else {
        const extended = extractExtendedHeading(html);
        chapterTitle = extended || `Part ${order + 1}`;
      }
    }

    const preview = extractPreview(text);

    // Store the resolved href so we can map it during omnibus detection
    const contentType = detectContentType(chapterTitle, text.trim().length);

    chapters.push({
      id: itemId,
      title: chapterTitle,
      text: text.trim(),
      order: order++,
      preview,
      contentType,
      _href: candidates[0],
      _htmlHead: html.slice(0, 1024),
    } as EbookChapter & { _href: string; _htmlHead: string });
  }

  if (chapters.length === 0) {
    throw new Error('Could not extract any chapters from this EPUB. The file may be DRM-protected or use an unsupported format.');
  }

  // 5. Detect omnibus structure (NCX hierarchy or title patterns)
  const bookMap = await detectOmnibusStructure(zip, opfDir, opfXml, chapters as Array<EbookChapter & { _href: string }>);
  const books: string[] = [];
  if (bookMap.size > 0) {
    for (const ch of chapters) {
      const info = bookMap.get(ch.id);
      if (info) {
        ch.bookIndex = info.bookIndex;
        ch.bookTitle = info.bookTitle;
        if (!books[info.bookIndex]) books[info.bookIndex] = info.bookTitle;
      }
    }
    // Fill forward: chapters without an explicit mapping inherit the last seen bookIndex
    let lastBookIndex = 0;
    let lastBookTitle = books[0] ?? '';
    for (const ch of chapters) {
      if (ch.bookIndex !== undefined) {
        lastBookIndex = ch.bookIndex;
        lastBookTitle = ch.bookTitle ?? lastBookTitle;
      } else {
        ch.bookIndex = lastBookIndex;
        ch.bookTitle = lastBookTitle;
      }
    }
  }

  // Clean up the internal _href field (_htmlHead is kept for page.tsx to read during saveChapters)
  for (const ch of chapters) delete (ch as unknown as Record<string, unknown>)._href;

  return { title, author, chapters, books: books.length > 0 ? books : [title] };
}

// ---- Chapter title extraction from NCX / EPUB3 nav ----

type ZipLike = { file: (name: string) => ({ async: (type: 'text') => Promise<string> } | null) };

/** Build a map of (href basename → label) from the NCX or EPUB3 nav document.
 *  Returns empty map if neither is present. */
async function buildNcxTitleMap(
  zip: ZipLike,
  opfDir: string,
  opfXml: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  // --- Try EPUB3 nav.xhtml first ---
  const navMatch =
    opfXml.match(/<item[^>]+properties="[^"]*nav[^"]*"[^>]+href="([^"]+)"/i) ||
    opfXml.match(/<item[^>]+href="([^"]+)"[^>]+properties="[^"]*nav[^"]*"/i);
  if (navMatch) {
    const navPath = opfDir + navMatch[1];
    const navHtml = await zip.file(navPath)?.async('text');
    if (navHtml) {
      // Parse <nav epub:type="toc"> … <a href="…">Title</a> …
      const tocSection = navHtml.match(/<nav[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? navHtml;
      for (const m of tocSection.matchAll(/<a[^>]+href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const label = extractText(m[2]).trim();
        const src = m[1].trim().split('/').pop()!;
        if (label && src && !isGenericTitle(label)) result.set(src, label);
      }
      if (result.size > 0) return result;
    }
  }

  // --- Fall back to NCX ---
  const ncxMatch =
    opfXml.match(/<item[^>]+media-type="application\/x-dtbncx\+xml"[^>]+href="([^"]+)"/i) ||
    opfXml.match(/<item[^>]+href="([^"]+)"[^>]+media-type="application\/x-dtbncx\+xml"/i);
  if (!ncxMatch) return result;

  const ncxPath = opfDir + ncxMatch[1];
  const ncxXml = await zip.file(ncxPath)?.async('text');
  if (!ncxXml) return result;

  for (const item of parseNcxItems(ncxXml)) {
    if (item.label && !isGenericTitle(item.label)) {
      const basename = item.src.split('/').pop()!;
      result.set(basename, item.label);
    }
  }
  return result;
}

/** Returns true for generic/useless titles we should skip in favour of HTML heading or Part N. */
function isGenericTitle(title: string): boolean {
  return /^(chapter|part|section|ch\.?|p\.?)\s*\d+$/i.test(title.trim());
}

const FRONT_MATTER_TITLE_RE = /^\s*(acknowledgements?|acknowledgments?|foreword|fore\s*word|preface|dedication|about\s+the\s+author|author'?s?\s+note|note\s+(from|by)\s+the\s+author|copyright|contents|table\s+of\s+contents|cast\s+of\s+characters|dramatis\s+personae|maps?|epigraph|title\s+page)\s*$/i;

const BACK_MATTER_TITLE_RE = /^\s*(acknowledgements?|acknowledgments?|about\s+the\s+author|author'?s?\s+note|note\s+(from|by)\s+the\s+author|also\s+by|other\s+books|bibliography|glossary|index|appendix|afterword|bonus|excerpt|preview|sneak\s+peek|reading\s+group|book\s+club|discussion\s+questions?)\s*$/i;

export function detectContentType(
  title: string,
  textLength: number,
): 'story' | 'front-matter' | 'back-matter' | 'structural' {
  if (textLength < 50) return 'structural';
  if (FRONT_MATTER_TITLE_RE.test(title)) return 'front-matter';
  if (BACK_MATTER_TITLE_RE.test(title)) return 'back-matter';
  return 'story';
}

// ---- Omnibus detection ----

/** Attempt to detect individual books within an omnibus EPUB.
 *  Returns a map from chapter id → { bookIndex, bookTitle }, or empty map if not an omnibus. */
async function detectOmnibusStructure(
  zip: ZipLike,
  opfDir: string,
  opfXml: string,
  chapters: Array<EbookChapter & { _href: string }>,
): Promise<Map<string, { bookIndex: number; bookTitle: string }>> {
  // Try NCX first (EPUB2)
  const ncxResult = await tryNcxDetection(zip, opfDir, opfXml, chapters);
  if (ncxResult.size > 0) return ncxResult;

  // Fall back to chapter title pattern matching
  return titlePatternDetection(chapters);
}

interface NcxNavItem { depth: number; label: string; src: string; }

/** Parse NCX navPoints into a flat list with depth information. */
function parseNcxItems(ncxXml: string): NcxNavItem[] {
  const items: NcxNavItem[] = [];
  let pos = 0;
  let depth = 0;
  let pendingLabel = '';

  while (pos < ncxXml.length) {
    // Find the next relevant tag
    const candidates: Array<{ pos: number; type: string }> = [];
    const openPos = ncxXml.indexOf('<navPoint', pos);
    const closePos = ncxXml.indexOf('</navPoint', pos);
    const labelPos = ncxXml.indexOf('<navLabel', pos);
    const contentPos = ncxXml.indexOf('<content', pos);
    if (openPos >= 0) candidates.push({ pos: openPos, type: 'open' });
    if (closePos >= 0) candidates.push({ pos: closePos, type: 'close' });
    if (labelPos >= 0) candidates.push({ pos: labelPos, type: 'label' });
    if (contentPos >= 0) candidates.push({ pos: contentPos, type: 'content' });
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.pos - b.pos);
    const next = candidates[0];

    if (next.type === 'open') {
      depth++;
      pos = next.pos + 9;
    } else if (next.type === 'close') {
      depth--;
      pos = next.pos + 10;
    } else if (next.type === 'label') {
      const end = ncxXml.indexOf('</navLabel>', next.pos);
      if (end > 0) {
        const inner = ncxXml.slice(next.pos, end);
        const textMatch = inner.match(/<text[^>]*>([\s\S]*?)<\/text>/i);
        pendingLabel = textMatch ? extractText(textMatch[1]) : '';
        pos = end + 11;
      } else {
        pos = next.pos + 9;
      }
    } else if (next.type === 'content') {
      const tagEnd = ncxXml.indexOf('>', next.pos);
      if (tagEnd > 0) {
        const tag = ncxXml.slice(next.pos, tagEnd + 1);
        const srcMatch = tag.match(/src="([^"#]+)/);
        if (srcMatch) {
          items.push({ depth, label: pendingLabel, src: srcMatch[1].trim() });
          pendingLabel = '';
        }
        pos = tagEnd + 1;
      } else {
        pos = next.pos + 8;
      }
    }
  }
  return items;
}

async function tryNcxDetection(
  zip: ZipLike,
  opfDir: string,
  opfXml: string,
  chapters: Array<EbookChapter & { _href: string }>,
): Promise<Map<string, { bookIndex: number; bookTitle: string }>> {
  const empty = new Map<string, { bookIndex: number; bookTitle: string }>();

  // Find NCX href in manifest
  const ncxMatch =
    opfXml.match(/<item[^>]+media-type="application\/x-dtbncx\+xml"[^>]+href="([^"]+)"/i) ||
    opfXml.match(/<item[^>]+href="([^"]+)"[^>]+media-type="application\/x-dtbncx\+xml"/i);
  if (!ncxMatch) return empty;

  const ncxPath = opfDir + ncxMatch[1];
  const ncxXml = await zip.file(ncxPath)?.async('text');
  if (!ncxXml) return empty;

  const items = parseNcxItems(ncxXml);

  // Check if there are depth-1 entries that act as book headings (they have depth-2 children)
  const depth1Items = items.filter((it) => it.depth === 1);
  const depth2Items = items.filter((it) => it.depth === 2);
  // Require at least 2 top-level groups, each containing at least 2 children
  if (depth1Items.length < 2 || depth2Items.length < depth1Items.length * 2) return empty;

  // Build a lookup: basename of src → chapter id
  const hrefToId = new Map<string, string>();
  for (const ch of chapters) {
    const basename = ch._href.split('/').pop()!;
    hrefToId.set(basename, ch.id);
    hrefToId.set(ch._href, ch.id);
  }

  const result = new Map<string, { bookIndex: number; bookTitle: string }>();
  let bookIndex = 0;
  let currentBookTitle = '';
  let currentBookIndex = 0;

  for (const item of items) {
    if (item.depth === 1) {
      currentBookTitle = item.label;
      currentBookIndex = bookIndex++;
      // Map the depth-1 entry's own content file (title page) to this book
      const id = hrefToId.get(item.src) ?? hrefToId.get(item.src.split('/').pop()!);
      if (id) result.set(id, { bookIndex: currentBookIndex, bookTitle: currentBookTitle });
    } else if (item.depth === 2) {
      const id = hrefToId.get(item.src) ?? hrefToId.get(item.src.split('/').pop()!);
      if (id) result.set(id, { bookIndex: currentBookIndex, bookTitle: currentBookTitle });
    }
  }

  return result;
}

const BOOK_BOUNDARY_RE =
  /^(Book|Part|Volume|Bk\.?)\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d{1,2}|I{1,3}|IV|VI{0,3}|IX|X{0,2}I{0,3})([\s:—–-]|$)/i;

function titlePatternDetection(
  chapters: Array<EbookChapter & { _href: string }>,
): Map<string, { bookIndex: number; bookTitle: string }> {
  const empty = new Map<string, { bookIndex: number; bookTitle: string }>();
  const boundaries: Array<{ id: string; bookIndex: number; bookTitle: string }> = [];
  let bookIndex = 0;

  for (const ch of chapters) {
    if (BOOK_BOUNDARY_RE.test(ch.title)) {
      boundaries.push({ id: ch.id, bookIndex: bookIndex++, bookTitle: ch.title });
    }
  }

  if (boundaries.length < 2) return empty;

  const result = new Map<string, { bookIndex: number; bookTitle: string }>();
  for (const b of boundaries) result.set(b.id, { bookIndex: b.bookIndex, bookTitle: b.bookTitle });
  return result;
}

export function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Scan the first portion of HTML for heading-like elements beyond h1-h3.
 *  Looks for h4-h6, bold/strong-only paragraphs, and elements with title-like classes. */
export function extractExtendedHeading(html: string): string {
  const head = html.slice(0, 2000);

  // Try h4-h6
  const hMatch = head.match(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/i);
  if (hMatch) {
    const t = extractText(hMatch[1]).trim();
    if (t.length > 0 && t.length < 100) return t;
  }

  // Look for a <p> or <div> whose only meaningful child is <b>, <strong>, or <em>
  const boldParaRe = /<(?:p|div)[^>]*>\s*<(?:b|strong|em)>([\s\S]*?)<\/(?:b|strong|em)>\s*<\/(?:p|div)>/gi;
  for (const m of head.matchAll(boldParaRe)) {
    const t = extractText(m[1]).trim();
    if (t.length > 0 && t.length < 100) return t;
  }

  // Look for elements with title-like class names
  const classRe = /<(?:p|div|span)[^>]+class="[^"]*(?:title|heading|chapter|ct)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/gi;
  for (const m of head.matchAll(classRe)) {
    const t = extractText(m[1]).trim();
    if (t.length > 0 && t.length < 100 && !isGenericTitle(t)) return t;
  }

  return '';
}

/** Extract a short preview from the chapter's plain text — first non-empty line, capped at 80 chars. */
export function extractPreview(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 10) {
      return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 77) + '...';
    }
  }
  return '';
}
