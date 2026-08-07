import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Parents, RootContent } from 'mdast';
import type { BlockKind, ListMarkerKind, SourceRange } from '../types';
import { FlatText } from './flat';

export const PARSER_VERSION = 'mdast-gfm/2';

export interface CodeLine {
  text: string;
  srcStart: number;
  /** 1-based line number within the code block. */
  line: number;
}

/**
 * One readable block of the document, in traversal order, with its text already
 * flattened and mapped back to the source.
 */
export interface RawBlock {
  kind: BlockKind;
  range: SourceRange;
  flat: FlatText;
  /** Heading level (1-6) or list nesting depth. */
  depth?: number;
  language?: string;
  codeLines?: CodeLine[];
  /** Set on the first block of a list item only. */
  marker?: { text: string; kind: ListMarkerKind; range: SourceRange };
}

function offsetsOf(node: Nodes): SourceRange {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? start;
  return { start, end };
}

/**
 * Flatten inline content into readable text.
 *
 * Text nodes contribute their *source slice* rather than their parsed value, so
 * flat offsets stay linearly mappable to source offsets. Inline code is kept as
 * a single atomic piece: `Decimal(9, 3)` must survive tokenization intact
 * (SPEC 7.6).
 */
function collectInline(nodes: RootContent[], source: string, flat: FlatText): void {
  for (const node of nodes) {
    const { start, end } = offsetsOf(node);
    switch (node.type) {
      case 'text':
        flat.append(source.slice(start, end), start, end);
        break;
      case 'inlineCode':
        flat.append(node.value, start, end, true);
        break;
      case 'break':
        flat.appendSeparator(' ');
        break;
      case 'image':
        // Alt text is not a verbatim source slice, so keep it piece-atomic.
        if (node.alt) flat.append(node.alt, start, end, true);
        break;
      case 'html':
      case 'footnoteReference':
        // Degrade quietly: inline HTML is markup, not prose.
        break;
      case 'emphasis':
      case 'strong':
      case 'delete':
      case 'link':
      case 'linkReference':
      case 'footnoteDefinition':
        collectInline(node.children as RootContent[], source, flat);
        break;
      default:
        if ('children' in node && Array.isArray((node as Parents).children)) {
          collectInline((node as Parents).children as RootContent[], source, flat);
        } else if ('value' in node && typeof node.value === 'string') {
          flat.append(source.slice(start, end), start, end);
        }
    }
  }
}

function inlineBlock(
  kind: BlockKind,
  node: Parents,
  source: string,
  depth?: number,
): RawBlock | null {
  const flat = new FlatText();
  collectInline(node.children as RootContent[], source, flat);
  if (flat.text.trim().length === 0) return null;
  const block: RawBlock = { kind, range: offsetsOf(node), flat };
  if (depth !== undefined) block.depth = depth;
  return block;
}

/**
 * Split a fenced or indented code block into lines, resolving each line's true
 * source offset. Indented blocks have their indentation stripped from `value`,
 * so lines are located by forward search rather than arithmetic.
 */
function codeLines(node: Nodes & { value: string }, source: string): CodeLine[] {
  const { start, end } = offsetsOf(node);
  const raw = source.slice(start, end);
  const lines = node.value.split('\n');
  const out: CodeLine[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    let at = text.length > 0 ? raw.indexOf(text, cursor) : -1;
    if (at === -1) at = cursor;
    out.push({ text, srcStart: start + at, line: i + 1 });
    cursor = at + text.length;
  }
  return out;
}

/**
 * Recover a list item's marker from the source.
 *
 * mdast strips `1.`, `-` and `[x]` from the item's content, so the marker is
 * read back out of the original text between the item's start and its first
 * child. That keeps the display text byte-faithful to what the author wrote
 * (`1.` versus `1)`) and gives the unit a real source range.
 */
function markerFor(
  item: Nodes & { checked?: boolean | null },
  ordered: boolean,
  ordinal: number,
  source: string,
): RawBlock['marker'] {
  const start = item.position?.start.offset ?? 0;
  const firstChild = (item as Parents).children?.[0];
  const contentStart = firstChild?.position?.start.offset ?? start;
  const raw = source.slice(start, contentStart);
  const trimmed = raw.trimEnd();
  const range: SourceRange = { start, end: start + (trimmed.length || raw.length) };

  // A task item's checkbox carries the meaning; the bullet in front of it does not.
  if (item.checked === true) return { text: '☑', kind: 'task-done', range };
  if (item.checked === false) return { text: '☐', kind: 'task-todo', range };

  if (ordered) {
    // Prefer the author's own delimiter, falling back to a computed number.
    const literal = trimmed.trim();
    return {
      text: /^\d+[.)]$/.test(literal) ? literal : `${ordinal}.`,
      kind: 'ordered',
      range,
    };
  }
  return { text: '•', kind: 'bullet', range };
}

function walk(nodes: RootContent[], source: string, out: RawBlock[], listDepth: number): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const block = inlineBlock('heading', node, source, node.depth);
        if (block) out.push(block);
        break;
      }
      case 'paragraph': {
        const block = inlineBlock(listDepth > 0 ? 'list-item' : 'paragraph', node, source, listDepth);
        if (block) out.push(block);
        break;
      }
      case 'blockquote': {
        const nested: RawBlock[] = [];
        walk(node.children as RootContent[], source, nested, listDepth);
        for (const b of nested) out.push(b.kind === 'paragraph' ? { ...b, kind: 'blockquote' } : b);
        break;
      }
      case 'list': {
        const ordered = node.ordered === true;
        let ordinal = node.start ?? 1;
        for (const item of node.children) {
          const before = out.length;
          walk([item] as RootContent[], source, out, listDepth + 1);
          // The marker belongs to the item's first block; a loose item's later
          // paragraphs are continuations and get no marker of their own.
          const first = out[before];
          if (first) first.marker = markerFor(item, ordered, ordinal, source);
          if (ordered) ordinal++;
        }
        break;
      }
      case 'listItem':
        walk(node.children as RootContent[], source, out, listDepth);
        break;
      case 'code': {
        const lines = codeLines(node, source);
        out.push({
          kind: 'code',
          range: offsetsOf(node),
          flat: new FlatText(),
          language: node.lang ?? '',
          codeLines: lines,
        });
        break;
      }
      case 'table':
        for (const row of node.children) {
          for (const cell of row.children) {
            const block = inlineBlock('table-cell', cell, source);
            if (block) out.push(block);
          }
        }
        break;
      case 'thematicBreak':
        out.push({ kind: 'thematic-break', range: offsetsOf(node), flat: new FlatText() });
        break;
      case 'html': {
        // Block-level HTML is not prose; surface it as plain readable text so
        // nothing from the source silently disappears (SPEC 15, parser failure).
        const { start, end } = offsetsOf(node);
        const flat = new FlatText();
        flat.append(source.slice(start, end), start, end);
        out.push({ kind: 'paragraph', range: { start, end }, flat });
        break;
      }
      case 'definition':
        break;
      default:
        if ('children' in node && Array.isArray((node as Parents).children)) {
          walk((node as Parents).children as RootContent[], source, out, listDepth);
        }
    }
  }
}

/** Parse Markdown (or plain text) into ordered readable blocks. */
export function parseBlocks(source: string): RawBlock[] {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const out: RawBlock[] = [];
  walk(tree.children, source, out, 0);
  return out;
}

/** Treat the whole input as one plain-text block (parser-failure fallback). */
export function plainTextBlocks(source: string): RawBlock[] {
  const out: RawBlock[] = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const flat = new FlatText();
    flat.append(m[0], m.index, m.index + m[0].length);
    out.push({ kind: 'paragraph', range: { start: m.index, end: m.index + m[0].length }, flat });
  }
  return out;
}

const MARKDOWN_SIGNALS = [
  /^#{1,6}\s+\S/m,
  /^```/m,
  /^\s*[-*+]\s+\S/m,
  /^\s*\d+\.\s+\S/m,
  /^>\s+\S/m,
  /\[[^\]]+\]\([^)]+\)/,
  /`[^`\n]+`/,
  /^\|.*\|$/m,
];

/** Heuristic Markdown detection; never rewrites the input (SPEC 12). */
export function looksLikeMarkdown(source: string): boolean {
  return MARKDOWN_SIGNALS.some((re) => re.test(source));
}
