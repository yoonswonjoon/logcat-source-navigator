import { MessageTemplate, TemplateSegment } from './types';

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -\/]*[@-~]/g;
const FORMAT_TOKEN = /%%|%[-+# 0,(<]*\d*(?:\.\d+)?(?:[tT])?[a-zA-Z]/g;

export function normalizeMessage(value: string): string {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

export function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: 'single' | 'double' | 'backtick' | undefined;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (quote === 'double' && char === '"') ||
        (quote === 'single' && char === "'") ||
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
    } else if (char === '(' || char === '[' || char === '{' || char === '<') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}' || char === '>') {
      depth = Math.max(0, depth - 1);
    } else if (char === delimiter && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts;
}

export function quotedStringValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== '"') {
    return undefined;
  }

  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      if (index !== trimmed.length - 1) {
        return undefined;
      }
      return unescapeString(trimmed.slice(1, -1));
    }
  }
  return undefined;
}

function unescapeString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|[\\"'nrtbf])/g, (_match, token: string) => {
    if (token.startsWith('u')) {
      return String.fromCharCode(Number.parseInt(token.slice(1), 16));
    }
    const replacements: Record<string, string> = {
      '\\': '\\',
      '"': '"',
      "'": "'",
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f'
    };
    return replacements[token] ?? token;
  });
}

function normalizeLiteral(value: string): string {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\t ]+/g, ' ');
}

function addLiteral(segments: TemplateSegment[], value: string): void {
  const normalized = normalizeLiteral(value);
  if (!normalized) {
    return;
  }
  const previous = segments.at(-1);
  if (previous?.kind === 'literal') {
    previous.value = `${previous.value}${normalized}`;
    return;
  }
  segments.push({ kind: 'literal', value: normalized });
}

function addDynamic(segments: TemplateSegment[]): void {
  if (segments.at(-1)?.kind !== 'dynamic') {
    segments.push({ kind: 'dynamic' });
  }
}

function appendInterpolatedLiteral(segments: TemplateSegment[], literal: string): void {
  let cursor = 0;
  const interpolation = /\$(?:\{[^}]+\}|[A-Za-z_][\w]*)/g;
  for (const match of literal.matchAll(interpolation)) {
    addLiteral(segments, literal.slice(cursor, match.index));
    addDynamic(segments);
    cursor = (match.index ?? 0) + match[0].length;
  }
  addLiteral(segments, literal.slice(cursor));
}

function appendPrintfLiteral(segments: TemplateSegment[], literal: string): void {
  let cursor = 0;
  for (const match of literal.matchAll(FORMAT_TOKEN)) {
    addLiteral(segments, literal.slice(cursor, match.index));
    if (match[0] === '%%') {
      addLiteral(segments, '%');
    } else {
      addDynamic(segments);
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  addLiteral(segments, literal.slice(cursor));
}

function firstQuotedArgument(value: string): string | undefined {
  const open = value.indexOf('(');
  if (open < 0) {
    return undefined;
  }
  const args = splitTopLevel(value.slice(open + 1, value.lastIndexOf(')')), ',');
  return args.map(quotedStringValue).find((item): item is string => item !== undefined);
}

export function templateFromExpression(expression: string, options: { printf?: boolean } = {}): MessageTemplate {
  const segments: TemplateSegment[] = [];
  const parts = splitTopLevel(expression.trim(), '+');

  for (const part of parts) {
    const literal = quotedStringValue(part);
    if (literal !== undefined) {
      if (options.printf) {
        appendPrintfLiteral(segments, literal);
      } else {
        appendInterpolatedLiteral(segments, literal);
      }
      continue;
    }

    if (/\b(?:String\s*\.\s*)?format\s*\(/.test(part)) {
      const formatLiteral = firstQuotedArgument(part);
      if (formatLiteral !== undefined) {
        appendPrintfLiteral(segments, formatLiteral);
        continue;
      }
    }
    addDynamic(segments);
  }

  const staticChars = segments.reduce(
    (total, segment) => total + (segment.kind === 'literal' ? segment.value.length : 0),
    0
  );
  const isLiteralOnly = segments.every((segment) => segment.kind === 'literal');
  const preview = segments
    .map((segment) => (segment.kind === 'literal' ? segment.value : '{value}'))
    .join('');

  return { segments, staticChars, isLiteralOnly, preview };
}

export function templateMatches(template: MessageTemplate, rawMessage: string): boolean {
  const message = normalizeMessage(rawMessage);
  const literals = template.segments.filter(
    (segment): segment is Extract<TemplateSegment, { kind: 'literal' }> => segment.kind === 'literal'
  );
  if (literals.length === 0) {
    return false;
  }

  const startsDynamic = template.segments[0]?.kind === 'dynamic';
  const endsDynamic = template.segments.at(-1)?.kind === 'dynamic';
  let cursor = 0;

  for (let index = 0; index < literals.length; index += 1) {
    const literal = literals[index].value;
    const found = message.indexOf(literal, cursor);
    if (found < 0 || (index === 0 && !startsDynamic && found !== 0)) {
      return false;
    }
    cursor = found + literal.length;
  }

  return endsDynamic || cursor === message.length;
}
