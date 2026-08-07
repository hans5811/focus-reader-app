// Prism must be told not to auto-highlight before core evaluates; in the main
// process there is no document, but this keeps the module safe to import
// anywhere.
(globalThis as Record<string, unknown>).Prism = { manual: true, disableWorkerMessageHandler: true };

import Prism from 'prismjs';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-swift.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-diff.js';

export const HIGHLIGHTER_VERSION = 'prism/1';

/** Flat, non-overlapping syntax token with offsets into the highlighted text. */
export interface FlatToken {
  type: string;
  start: number;
  end: number;
}

const ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  golang: 'go',
  yml: 'yaml',
  html: 'markup',
  xml: 'markup',
  postgres: 'sql',
  psql: 'sql',
  plaintext: '',
  text: '',
  '': '',
};

/** Resolve a fence info string to a supported Prism grammar name, or ''. */
export function resolveLanguage(lang: string | undefined): string {
  const raw = (lang ?? '').trim().toLowerCase().split(/[\s,:]/)[0];
  const name = raw in ALIASES ? ALIASES[raw] : raw;
  if (!name) return '';
  return Prism.languages[name] ? name : '';
}

/**
 * Tokenize code into a flat, ordered, gap-free token list.
 *
 * Concatenating token texts reproduces the input exactly, which is what makes
 * the offsets trustworthy. Unsupported languages yield a single `plain` token
 * so callers get the documented deterministic fallback (SPEC 15).
 */
export function tokenizeCode(code: string, language: string): FlatToken[] {
  const grammar = language ? Prism.languages[language] : undefined;
  if (!grammar) return [{ type: 'plain', start: 0, end: code.length }];

  const out: FlatToken[] = [];
  let offset = 0;

  const visit = (node: string | Prism.Token | (string | Prism.Token)[], type: string): void => {
    if (typeof node === 'string') {
      if (node.length > 0) out.push({ type, start: offset, end: offset + node.length });
      offset += node.length;
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, type);
      return;
    }
    visit(node.content as string | Prism.Token | (string | Prism.Token)[], node.type || type);
  };

  try {
    for (const token of Prism.tokenize(code, grammar)) visit(token, 'plain');
  } catch {
    return [{ type: 'plain', start: 0, end: code.length }];
  }

  // Defensive: if the grammar dropped or duplicated text, fall back rather than
  // emit ranges that do not line up with the source.
  if (offset !== code.length) return [{ type: 'plain', start: 0, end: code.length }];
  return out;
}

/** Token types whose contents must never be split into separate reading units. */
const ATOMIC_TOKEN_TYPES = new Set([
  'comment',
  'string',
  'template-string',
  'char',
  'regex',
  'doc-comment',
  'triple-quoted-string',
  'string-interpolation',
  'attr-value',
]);

export function isAtomicToken(type: string): boolean {
  return ATOMIC_TOKEN_TYPES.has(type);
}
