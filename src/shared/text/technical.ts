import type { EntityKind, UnitKind } from '../types';

/**
 * Deterministic technical recognition (SPEC 7.5).
 *
 * Recognition only *annotates* text — it never rewrites it. Prose context is
 * deliberately conservative so ordinary English is not mistaken for code;
 * code context can be aggressive because the surrounding fence already told us
 * the text is technical.
 */
export type RecognitionContext = 'prose' | 'code';

export interface Recognition {
  entity: EntityKind;
  kind: UnitKind;
}

const KNOWN_EXTENSIONS = new Set([
  'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'md', 'markdown', 'json',
  'jsonc', 'toml', 'yaml', 'yml', 'sql', 'sh', 'bash', 'zsh', 'fish', 'swift',
  'go', 'rs', 'rb', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'txt', 'lock', 'cfg', 'ini',
  'conf', 'env', 'proto', 'graphql', 'gradle', 'plist', 'entitlements', 'csv',
  'tsv', 'log', 'diff', 'patch', 'svg', 'png', 'jpg', 'pdf', 'zip', 'tar', 'gz',
]);

/** Prose abbreviations that must not be mistaken for dotted symbols. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'viz', 'a.m', 'p.m', 'ca']);

const SHELL_COMMANDS = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'git', 'cd', 'ls', 'cat', 'rm', 'mv', 'cp',
  'mkdir', 'touch', 'echo', 'export', 'source', 'python', 'python3', 'pip',
  'pip3', 'node', 'deno', 'bun', 'go', 'cargo', 'rustc', 'make', 'cmake',
  'docker', 'kubectl', 'helm', 'psql', 'mysql', 'sqlite3', 'brew', 'curl',
  'wget', 'ssh', 'scp', 'rsync', 'grep', 'rg', 'find', 'sed', 'awk', 'jq',
  'chmod', 'chown', 'sudo', 'tar', 'unzip', 'open', 'xcodebuild', 'swift',
]);

const URL_RE = /^(?:https?|ftp|file|ssh|git|mailto):\/\/[^\s]+$|^www\.[^\s]+\.[^\s]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{7,64}$/i;
const VERSION_RE = /^v?\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?$/;
const POSIX_ANCHORED_PATH_RE = /^(?:~|\.{1,2})?\/[^\s\\]*$/;
const RELATIVE_PATH_RE = /^[\w.@%+-]+(?:\/[\w.@%+ -]+)+\/?$/;
const WINDOWS_PATH_RE = /^(?:[A-Za-z]:\\|\\\\)[^\s]*$/;
const FILENAME_RE = /^[\w][\w.@+-]*\.([A-Za-z0-9]+)$/;
const FLAG_RE = /^--?[A-Za-z][\w-]*$/;
const ENV_VAR_RE = /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/;
const SNAKE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const SCREAMING_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CAMEL_RE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;
const DOTTED_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CALL_RE = /^[A-Za-z_$][\w$.]*\((?:[^()]|\([^()]*\))*\)$/;
const CALL_DECL_RE = /^[A-Za-z_$][\w$.]*\((?:[^()]|\([^()]*\))*\)\s*:$/;
const ANNOTATION_RE = /^([A-Za-z_$][\w$.]*)\s*:\s*(\S.*)$/;
const ASSIGNMENT_RE = /^([A-Za-z_$][\w$.[\]]*)\s*(?:[-+*/|&]?=|:=)\s*(\S.*)$/;
const NUMBER_RE = /^[-+]?\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?$/i;

/** Characters that make a following `(` a call rather than a prose aside. */
export const CALL_HEAD_CHAR = /[A-Za-z0-9_$\].]/;

const ENTITY_TO_UNIT: Record<EntityKind, UnitKind> = {
  path: 'path',
  filename: 'path',
  url: 'path',
  identifier: 'identifier',
  'dotted-symbol': 'identifier',
  'env-var': 'identifier',
  'database-object': 'identifier',
  uuid: 'identifier',
  hash: 'identifier',
  version: 'identifier',
  flag: 'identifier',
  keyword: 'identifier',
  call: 'code-expression',
  'shell-command': 'code-expression',
  literal: 'code-expression',
  comment: 'code-expression',
  declaration: 'declaration',
  'type-annotation': 'declaration',
  assignment: 'declaration',
};

export function unitKindFor(entity: EntityKind): UnitKind {
  return ENTITY_TO_UNIT[entity];
}

function isIdentifierLike(text: string): boolean {
  return (
    SNAKE_RE.test(text) ||
    SCREAMING_RE.test(text) ||
    CAMEL_RE.test(text) ||
    (PASCAL_RE.test(text) && /[a-z]/.test(text)) ||
    DOTTED_RE.test(text) ||
    CALL_RE.test(text)
  );
}

function dottedSymbolAcceptable(text: string): boolean {
  if (ABBREVIATIONS.has(text.toLowerCase())) return false;
  if (text.length < 5) return false;
  const parts = text.split('.');
  if (parts.some((p) => p.length === 0)) return false;
  return parts.some((p) => p.length >= 2);
}

function pathAcceptable(text: string, context: RecognitionContext): boolean {
  if (context === 'code') return true;
  // In prose, require an unambiguous signal so "and/or" stays prose.
  if (/^(?:~|\.{1,2})?\//.test(text)) return true;
  const slashes = (text.match(/\//g) ?? []).length;
  if (slashes >= 2) return true;
  const last = text.slice(text.lastIndexOf('/') + 1);
  const m = FILENAME_RE.exec(last);
  return m !== null && KNOWN_EXTENSIONS.has(m[1].toLowerCase());
}

/**
 * Classify a whitespace-free token. Returns `null` for ordinary prose.
 *
 * @param language Optional fenced-code language hint, used for SQL schema objects.
 */
export function recognize(
  text: string,
  context: RecognitionContext = 'prose',
  language?: string,
): Recognition | null {
  if (text.length === 0) return null;

  const entity = recognizeEntity(text, context, language);
  return entity ? { entity, kind: unitKindFor(entity) } : null;
}

function recognizeEntity(
  text: string,
  context: RecognitionContext,
  language?: string,
): EntityKind | null {
  if (URL_RE.test(text)) return 'url';
  if (UUID_RE.test(text)) return 'uuid';
  if (VERSION_RE.test(text)) return 'version';
  if (NUMBER_RE.test(text)) return context === 'code' ? 'literal' : null;
  if (ENV_VAR_RE.test(text)) return 'env-var';
  if (FLAG_RE.test(text)) return 'flag';

  if (WINDOWS_PATH_RE.test(text)) return 'path';
  if (
    (POSIX_ANCHORED_PATH_RE.test(text) || RELATIVE_PATH_RE.test(text)) &&
    text.includes('/') &&
    pathAcceptable(text, context)
  ) {
    return 'path';
  }

  if (CALL_DECL_RE.test(text)) return 'declaration';
  if (CALL_RE.test(text)) return 'call';

  const annotation = ANNOTATION_RE.exec(text);
  if (annotation && (context === 'code' || isIdentifierLike(annotation[1]))) {
    return 'type-annotation';
  }
  const assignment = ASSIGNMENT_RE.exec(text);
  if (assignment && (context === 'code' || isIdentifierLike(assignment[1]))) {
    return 'assignment';
  }

  const filename = FILENAME_RE.exec(text);
  if (filename && KNOWN_EXTENSIONS.has(filename[1].toLowerCase())) return 'filename';

  if (SNAKE_RE.test(text) || SCREAMING_RE.test(text)) return 'identifier';
  if (CAMEL_RE.test(text) && text.length >= 4) return 'identifier';
  // PascalCase needs two humps and a lowercase letter so "Readings" and "AWS"
  // stay prose while "SensorReading" is recognized.
  if (
    PASCAL_RE.test(text) &&
    text.length >= 4 &&
    /[a-z]/.test(text) &&
    /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(text)
  ) {
    return 'identifier';
  }

  if (DOTTED_RE.test(text) && dottedSymbolAcceptable(text)) {
    return language === 'sql' ? 'database-object' : 'dotted-symbol';
  }

  if (context === 'code') {
    if (SHELL_COMMANDS.has(text)) return 'shell-command';
    if (HASH_RE.test(text) && text.length >= 7) return 'hash';
    if (/^[A-Za-z_$][\w$]*$/.test(text)) return 'identifier';
    return 'literal';
  }

  // In prose a bare hex run is only a hash when it cannot be an English word.
  if (HASH_RE.test(text) && text.length >= 7 && /\d/.test(text)) return 'hash';

  return null;
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'’”]+$/;
const LEADING_PUNCTUATION = /^[([{"'‘“]+/;

export interface SplitToken {
  leading: string;
  core: string;
  trailing: string;
}

/** Separate a display token into leading punctuation, core, and trailing punctuation. */
export function splitPunctuation(text: string): SplitToken {
  const leadMatch = LEADING_PUNCTUATION.exec(text);
  const leading = leadMatch ? leadMatch[0] : '';
  let rest = text.slice(leading.length);
  const trailMatch = TRAILING_PUNCTUATION.exec(rest);
  const trailing = trailMatch ? trailMatch[0] : '';
  rest = rest.slice(0, rest.length - trailing.length);
  return { leading, core: rest, trailing };
}

/**
 * Recognize a token that may carry surrounding punctuation.
 *
 * The full token is tried first so `SensorReading(BaseModel):` and paths ending
 * in `/` keep their meaningful trailing characters, then the bare core is tried.
 */
export function recognizeToken(
  text: string,
  context: RecognitionContext = 'prose',
  language?: string,
): Recognition | null {
  const direct = recognize(text, context, language);
  if (direct) return direct;
  const { core } = splitPunctuation(text);
  if (core.length === 0 || core === text) return null;
  return recognize(core, context, language);
}
