import { CALL_HEAD_CHAR } from './technical';

export interface ProseToken {
  start: number;
  end: number;
  text: string;
  /** True when the token came from an inline-code region. */
  atomic: boolean;
}

export interface TokenizeHooks {
  isAtomic(offset: number): boolean;
  /** End offset of the atomic region containing `offset`, exclusive. */
  atomicEnd(offset: number): number;
}

const NO_ATOMIC: TokenizeHooks = { isAtomic: () => false, atomicEnd: (i) => i };

/** Budget for merging a call expression back together across whitespace. */
const MAX_MERGE_CHUNKS = 5;
const MAX_MERGE_LENGTH = 160;

const isSpace = (ch: string) => /\s/.test(ch);

/**
 * Depth of unbalanced *call* parentheses in a chunk.
 *
 * A `(` counts only when it opens a call — i.e. it directly follows an
 * identifier character, or we are already inside a call. A leading `(` starting
 * a prose aside is ignored so `(derived` never tries to merge (SPEC 5.7).
 */
function callDepth(chunk: string, initial = 0): number {
  let depth = initial;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (ch === '(') {
      const prev = i > 0 ? chunk[i - 1] : '';
      if (depth > 0 || (prev !== '' && CALL_HEAD_CHAR.test(prev))) depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    }
  }
  return depth;
}

/**
 * Split prose into reading tokens (SPEC 7.6).
 *
 * Whitespace separates tokens, trailing punctuation stays attached to its word,
 * inline-code regions are emitted whole, and a call expression split across
 * whitespace — `Decimal(9, 3)` written outside backticks — is re-joined into a
 * single token.
 */
export function tokenizeProse(text: string, hooks: TokenizeHooks = NO_ATOMIC): ProseToken[] {
  const tokens: ProseToken[] = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) break;

    if (hooks.isAtomic(i)) {
      const end = hooks.atomicEnd(i);
      tokens.push({ start: i, end, text: text.slice(i, end), atomic: true });
      i = end;
      continue;
    }

    const start = i;
    while (i < text.length && !isSpace(text[i]) && !hooks.isAtomic(i)) i++;
    let end = i;

    // Re-join an unbalanced call expression across whitespace, within budget.
    let depth = callDepth(text.slice(start, end));
    if (depth > 0) {
      let probe = end;
      let chunks = 0;
      while (depth > 0 && chunks < MAX_MERGE_CHUNKS && probe - start < MAX_MERGE_LENGTH) {
        let p = probe;
        while (p < text.length && isSpace(text[p])) p++;
        if (p >= text.length || hooks.isAtomic(p)) break;
        const chunkStart = p;
        while (p < text.length && !isSpace(text[p]) && !hooks.isAtomic(p)) p++;
        depth = callDepth(text.slice(chunkStart, p), depth);
        probe = p;
        chunks++;
      }
      if (depth === 0) {
        end = probe;
        i = probe;
      }
    }

    tokens.push({ start, end, text: text.slice(start, end), atomic: false });
  }

  return tokens;
}
