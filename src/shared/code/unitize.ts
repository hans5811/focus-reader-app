import type { CodeGranularity, CodeToken } from '../types';
import { isAtomicToken, type FlatToken } from './highlight';
import { visualLength } from '../timing';

export interface CodeUnit {
  /** Offset relative to the start of the code line. */
  start: number;
  end: number;
  text: string;
  tokens: CodeToken[];
}

/** Beyond this visual length a declaration-sized unit is re-split lexically. */
const MAX_DECLARATION_VISUAL_LENGTH = 64;

const OPENERS = '([{';
const CLOSERS = ')]}';

interface Breakpoints {
  /** Offsets at which a unit must end (exclusive). */
  hard: Set<number>;
}

/**
 * Compute unit boundaries for one code line.
 *
 * The lexer is language-independent — it only tracks bracket depth — and the
 * highlighter supplies the regions that must stay atomic (strings, comments).
 * That combination is what makes unsupported languages degrade predictably
 * rather than shatter into punctuation (SPEC 7.6).
 */
function breakpoints(line: string, atomic: FlatToken[], granularity: CodeGranularity): Breakpoints {
  const hard = new Set<number>();
  const inAtomic = (i: number) => atomic.some((t) => i >= t.start && i < t.end);

  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    if (inAtomic(i)) continue;
    const ch = line[i];
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ';' || ch === ',')) hard.add(i + 1);
    else if (depth === 0 && granularity === 'lexical' && /\s/.test(ch)) hard.add(i);
  }
  return { hard };
}

function sliceTokens(tokens: FlatToken[], start: number, end: number): CodeToken[] {
  const out: CodeToken[] = [];
  for (const t of tokens) {
    if (t.end <= start || t.start >= end) continue;
    out.push({
      type: t.type,
      start: Math.max(t.start, start) - start,
      end: Math.min(t.end, end) - start,
    });
  }
  return out;
}

function emit(line: string, tokens: FlatToken[], start: number, end: number, out: CodeUnit[]): void {
  // Trim surrounding whitespace without losing the interior of the unit.
  let s = start;
  let e = end;
  while (s < e && /\s/.test(line[s])) s++;
  while (e > s && /\s/.test(line[e - 1])) e--;
  if (s >= e) return;
  out.push({ start: s, end: e, text: line.slice(s, e), tokens: sliceTokens(tokens, s, e) });
}

function split(
  line: string,
  tokens: FlatToken[],
  atomic: FlatToken[],
  granularity: CodeGranularity,
  out: CodeUnit[],
): void {
  const { hard } = breakpoints(line, atomic, granularity);
  const cuts = [...hard].sort((a, b) => a - b);
  let cursor = 0;
  for (const cut of cuts) {
    if (cut <= cursor) continue;
    emit(line, tokens, cursor, cut, out);
    cursor = cut;
  }
  emit(line, tokens, cursor, line.length, out);
}

/** Split one line of a fenced code block into reading units. */
export function unitizeCodeLine(
  line: string,
  tokens: FlatToken[],
  granularity: CodeGranularity,
): CodeUnit[] {
  if (line.trim().length === 0) return [];
  const atomic = tokens.filter((t) => isAtomicToken(t.type));

  const units: CodeUnit[] = [];
  split(line, tokens, atomic, granularity, units);

  if (granularity !== 'declaration') return units;

  // A declaration that would render below the minimum technical size is
  // re-split at the next-smaller syntax-safe boundary (SPEC 7.6).
  const refined: CodeUnit[] = [];
  for (const unit of units) {
    if (visualLength(unit.text) <= MAX_DECLARATION_VISUAL_LENGTH) {
      refined.push(unit);
      continue;
    }
    const nested: CodeUnit[] = [];
    const localTokens = sliceTokens(tokens, unit.start, unit.end).map((t) => ({
      type: t.type,
      start: t.start,
      end: t.end,
    }));
    split(unit.text, localTokens, localTokens.filter((t) => isAtomicToken(t.type)), 'lexical', nested);
    for (const n of nested) {
      refined.push({
        start: unit.start + n.start,
        end: unit.start + n.end,
        text: n.text,
        tokens: n.tokens,
      });
    }
  }
  return refined;
}
