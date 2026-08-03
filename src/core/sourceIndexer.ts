import { createHash } from 'node:crypto';
import { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CustomLoggerDefinition,
  LogLevel,
  LoggerApi,
  SourceIndex,
  SourceIndexOptions,
  SourceLogSite
} from './types';
import { quotedStringValue, splitTopLevel, templateFromExpression } from './normalization';

const SOURCE_EXTENSIONS = new Set(['.java', '.kt', '.kts', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp']);

interface CallMatch {
  start: number;
  end: number;
  api: LoggerApi;
  level: LogLevel;
  tagExpression?: string;
  messageExpression?: string;
}

interface CustomCallPattern {
  pattern: RegExp;
  definition: CustomLoggerDefinition;
}

interface ConstantMap {
  values: Map<string, string>;
}

function levelFromJava(level: string): LogLevel {
  switch (level.toLowerCase()) {
    case 'v':
      return 'V';
    case 'd':
      return 'D';
    case 'i':
      return 'I';
    case 'w':
      return 'W';
    case 'e':
      return 'E';
    case 'wtf':
      return 'F';
    default:
      return 'D';
  }
}

function levelFromNative(level: string): LogLevel {
  const normalized = level.toUpperCase();
  if (normalized === 'F') return 'F';
  return normalized as Exclude<LogLevel, 'F'>;
}

function buildCodeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let mode: 'code' | 'lineComment' | 'blockComment' | 'single' | 'double' | 'backtick' = 'code';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === 'lineComment') {
      if (char === '\n') mode = 'code';
      continue;
    }
    if (mode === 'blockComment') {
      if (char === '*' && next === '/') {
        index += 1;
        mode = 'code';
      }
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'backtick') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (mode === 'single' && char === "'") ||
        (mode === 'double' && char === '"') ||
        (mode === 'backtick' && char === '`')
      ) {
        mode = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      index += 1;
      mode = 'lineComment';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 1;
      mode = 'blockComment';
      continue;
    }
    if (char === '"') {
      mode = 'double';
      continue;
    }
    if (char === "'") {
      mode = 'single';
      continue;
    }
    if (char === '`') {
      mode = 'backtick';
      continue;
    }
    mask[index] = 1;
  }

  return mask;
}

function findBalancedCall(source: string, openParen: number): { args: string; end: number } | undefined {
  let depth = 0;
  let quote: 'single' | 'double' | 'backtick' | undefined;
  let escaped = false;

  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (quote === 'single' && char === "'") ||
        (quote === 'double' && char === '"') ||
        (quote === 'backtick' && char === '`')
      ) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"') {
      quote = 'double';
    } else if (char === "'") {
      quote = 'single';
    } else if (char === '`') {
      quote = 'backtick';
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return { args: source.slice(openParen + 1, index), end: index + 1 };
      }
    }
  }
  return undefined;
}

function extractConstants(source: string): ConstantMap {
  const values = new Map<string, string>();
  const javaOrKotlin = /\b(?:static\s+final\s+String|const\s+val|val)\s+([A-Za-z_]\w*)\s*=\s*("(?:\\.|[^"\\])*")/g;
  const native = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+("(?:\\.|[^"\\])*")/gm;

  for (const match of source.matchAll(javaOrKotlin)) {
    const literal = quotedStringValue(match[2]);
    if (literal !== undefined) values.set(match[1], literal);
  }
  for (const match of source.matchAll(native)) {
    const literal = quotedStringValue(match[2]);
    if (literal !== undefined) values.set(match[1], literal);
  }
  return { values };
}

function resolveTag(expression: string | undefined, constants: ConstantMap): string | undefined {
  if (!expression) return undefined;
  const literal = quotedStringValue(expression);
  if (literal !== undefined) return literal;
  const identifier = expression.trim().match(/^([A-Za-z_]\w*)$/)?.[1];
  return identifier ? constants.values.get(identifier) : undefined;
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAndColumn(lineStarts: number[], position: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= position) low = mid + 1;
    else high = mid - 1;
  }
  const index = Math.max(0, high);
  return { line: index + 1, column: position - lineStarts[index] };
}

function findEnclosingFunction(lines: string[], line: number): string | undefined {
  const kotlinFunction = /\bfun\s+([A-Za-z_]\w*)\s*\(/;
  const functionLike = /(?:[A-Za-z_][\w<>,.?&*:\[\]\s]+)\s+([~A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/;
  const ignored = new Set(['if', 'for', 'while', 'switch', 'catch', 'when']);

  for (let index = line - 1; index >= 0; index -= 1) {
    const value = lines[index];
    const kotlin = value.match(kotlinFunction)?.[1];
    if (kotlin && !ignored.has(kotlin)) return kotlin;
    const generic = value.match(functionLike)?.[1];
    if (generic && !ignored.has(generic)) return generic;
  }
  return undefined;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function customReceiverPattern(receiver: string): RegExp | undefined {
  const parts = receiver
    .trim()
    .split('.')
    .map((part) => part.trim());
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part))
  ) {
    return undefined;
  }

  const expression = parts.map(escapeRegularExpression).join('\\s*\\.\\s*');
  // Keep this case-sensitive: `L` and `l` are commonly different local names.
  return new RegExp(
    `(?<![A-Za-z0-9_$])(${expression})\\s*\\.\\s*(v|d|i|w|e|wtf)\\s*\\(`,
    'g'
  );
}

function configuredCustomCallPatterns(definitions: CustomLoggerDefinition[] | undefined): CustomCallPattern[] {
  const patterns: CustomCallPattern[] = [];
  if (!Array.isArray(definitions)) return patterns;
  for (const definition of definitions) {
    if (!definition || typeof definition.receiver !== 'string') continue;
    const pattern = customReceiverPattern(definition.receiver);
    if (pattern) patterns.push({ pattern, definition });
  }
  return patterns;
}

function argumentAt(args: string[], index: number | undefined): string | undefined {
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < args.length ? args[index] : undefined;
}

function hasStaticMessageText(expression: string): boolean {
  return templateFromExpression(expression).staticChars > 0;
}

function looksLikeTagExpression(expression: string, constants: ConstantMap): boolean {
  // A string literal is ambiguous: in `L.e("message", error)` it is the
  // message, while in `L.e("tag", "message")` it is the tag.  The latter
  // is handled below only when the second argument actually has message text.
  if (quotedStringValue(expression) !== undefined) return false;
  if (resolveTag(expression, constants) !== undefined) return true;
  return /(?:^|[_$])(?:LOG_)?TAG(?:[_$]|$)/i.test(expression.trim());
}

function customWrapperArguments(
  args: string[],
  definition: CustomLoggerDefinition,
  constants: ConstantMap
): Pick<CallMatch, 'tagExpression' | 'messageExpression'> {
  const configuredMessage = argumentAt(args, definition.messageArgumentIndex);
  if (configuredMessage !== undefined) {
    return {
      tagExpression: argumentAt(args, definition.tagArgumentIndex),
      messageExpression: configuredMessage
    };
  }

  if (args.length === 0) return {};
  if (args.length === 1) return { messageExpression: args[0] };

  const [first, second] = args;
  const firstIsLiteral = quotedStringValue(first) !== undefined;
  const secondHasStaticText = hasStaticMessageText(second);
  const firstHasStaticText = hasStaticMessageText(first);

  // The usual direct facade signature is (tag, message[, throwable]).  Do
  // not mistake the common (message, throwable) wrapper shape for it: the
  // throwable normally has no static text, so the first argument stays the
  // message.  A non-standard shape can always pin both argument indices.
  if (
    looksLikeTagExpression(first, constants) ||
    (!firstHasStaticText && secondHasStaticText) ||
    (firstIsLiteral && secondHasStaticText)
  ) {
    return { tagExpression: first, messageExpression: second };
  }

  return { messageExpression: first };
}

function findCalls(
  source: string,
  constants: ConstantMap,
  customLoggers: CustomLoggerDefinition[] | undefined
): CallMatch[] {
  const mask = buildCodeMask(source);
  const matches: CallMatch[] = [];
  const patterns: Array<{
    pattern: RegExp;
    kind: 'java' | 'native' | 'print' | 'custom';
    definition?: CustomLoggerDefinition;
  }> = [
    {
      pattern: /\b(?:(?:android\s*\.\s*util\s*\.\s*)?)(Slog|Log)\s*\.\s*(v|d|i|w|e|wtf)\s*\(/gi,
      kind: 'java'
    },
    { pattern: /\b(ALOG[VDIWEF])\s*\(/g, kind: 'native' },
    { pattern: /\b__android_log_print\s*\(/g, kind: 'print' }
  ];
  patterns.push(
    ...configuredCustomCallPatterns(customLoggers).map(({ pattern, definition }) => ({
      pattern,
      kind: 'custom' as const,
      definition
    }))
  );

  for (const { pattern, kind, definition } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (!mask[start]) continue;
      const openParen = source.indexOf('(', start + match[0].length - 1);
      const call = findBalancedCall(source, openParen);
      if (!call) continue;
      const args = splitTopLevel(call.args, ',');

      if (kind === 'java') {
        const api = match[1] === 'Slog' ? 'Slog' : 'Log';
        if (args.length < 2) continue;
        matches.push({
          start,
          end: call.end,
          api,
          level: levelFromJava(match[2]),
          tagExpression: args[0],
          messageExpression: args[1]
        });
        continue;
      }

      if (kind === 'native') {
        matches.push({
          start,
          end: call.end,
          api: 'ALOG',
          level: levelFromNative(match[1].at(-1) ?? 'D'),
          tagExpression: constants.values.has('LOG_TAG') ? 'LOG_TAG' : undefined,
          messageExpression: args[0]
        });
        continue;
      }

      if (kind === 'custom') {
        if (!definition) continue;
        const argumentsForWrapper = customWrapperArguments(args, definition, constants);
        if (!argumentsForWrapper.messageExpression) continue;
        matches.push({
          start,
          end: call.end,
          api: 'Custom',
          level: levelFromJava(match[2]),
          ...argumentsForWrapper
        });
        continue;
      }

      if (args.length < 3) continue;
      const priority = args[0];
      const level = /FATAL/.test(priority)
        ? 'F'
        : /ERROR/.test(priority)
          ? 'E'
          : /WARN/.test(priority)
            ? 'W'
            : /INFO/.test(priority)
              ? 'I'
              : /VERBOSE/.test(priority)
                ? 'V'
                : 'D';
      matches.push({
        start,
        end: call.end,
        api: 'android_log_print',
        level,
        tagExpression: args[1],
        messageExpression: args[2]
      });
    }
  }

  return matches
    .sort((left, right) => left.start - right.start)
    .filter((call, index, values) => index === 0 || call.start >= values[index - 1].end);
}

export function extractLogSitesFromSource(
  source: string,
  filePath: string,
  relativePath: string,
  options: Pick<SourceIndexOptions, 'customLoggers'> = {}
): SourceLogSite[] {
  const constants = extractConstants(source);
  const lines = source.split(/\r?\n/);
  const lineStarts = buildLineStarts(source);

  return findCalls(source, constants, options.customLoggers)
    .filter((call) => call.messageExpression !== undefined)
    .map((call) => {
      const location = lineAndColumn(lineStarts, call.start);
      const sourcePreview = source
        .slice(call.start, call.end)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      const template = templateFromExpression(call.messageExpression ?? '', {
        printf: call.api === 'ALOG' || call.api === 'android_log_print'
      });
      const idSeed = `${filePath}:${location.line}:${location.column}:${call.api}`;
      return {
        id: createHash('sha1').update(idSeed).digest('hex').slice(0, 16),
        api: call.api,
        level: call.level,
        tag: resolveTag(call.tagExpression, constants),
        template,
        filePath,
        relativePath,
        line: location.line,
        column: location.column,
        functionName: findEnclosingFunction(lines, location.line),
        sourcePreview
      };
    });
}

async function* walkFiles(root: string, options: SourceIndexOptions): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!options.excludeDirectoryNames.includes(entry.name)) {
        yield* walkFiles(fullPath, options);
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield fullPath;
    }
  }
}

export async function buildSourceIndex(
  sourceRoots: string[],
  options: SourceIndexOptions,
  onProgress?: (scannedFiles: number, indexedSites: number, currentPath: string) => void
): Promise<SourceIndex> {
  const sites: SourceLogSite[] = [];
  let scannedFiles = 0;

  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = path.resolve(sourceRoot);
    for await (const filePath of walkFiles(absoluteRoot, options)) {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      if (fileStat.size > options.maxFileSizeBytes) continue;

      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }

      const relativePath = path.relative(absoluteRoot, filePath).replaceAll(path.sep, '/');
      sites.push(...extractLogSitesFromSource(content, filePath, relativePath, options));
      scannedFiles += 1;
      onProgress?.(scannedFiles, sites.length, filePath);
      if (scannedFiles % 75 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  return {
    version: 1,
    roots: sourceRoots.map((root) => path.resolve(root)),
    createdAt: new Date().toISOString(),
    sites
  };
}
