import { CALL_HEAD_CHAR } from './technical';
import type { Span } from './segment';

const OPENERS: Record<string, string> = { '(': ')', '[': ']' };

/**
 * Find balanced *prose* parenthetical spans (SPEC 5.7).
 *
 * An opening paren directly preceded by an identifier character is a technical
 * delimiter — `Decimal(9, 3)` — and is skipped. Only outermost balanced spans
 * are returned; nested and unmatched parens degrade to ordinary prose.
 */
export function findProseParentheticals(
  text: string,
  isAtomic: (offset: number) => boolean = () => false,
): Span[] {
  const spans: Span[] = [];
  const stack: { char: string; index: number; prose: boolean }[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isAtomic(i)) continue;

    if (ch === '(' || ch === '[') {
      const prev = i > 0 ? text[i - 1] : '';
      const isCall = prev !== '' && CALL_HEAD_CHAR.test(prev);
      stack.push({ char: ch, index: i, prose: !isCall && ch === '(' });
      continue;
    }

    if (ch === ')' || ch === ']') {
      // Unwind to the matching opener; anything skipped was unbalanced.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (OPENERS[stack[s].char] !== ch) continue;
        const open = stack[s];
        stack.length = s;
        // Only record a span when it is outermost among prose spans.
        if (open.prose && !stack.some((e) => e.prose)) {
          spans.push({ start: open.index, end: i + 1 });
        }
        break;
      }
    }
  }

  return spans;
}
