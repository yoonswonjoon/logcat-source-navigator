import { LogLevel, LogcatEvent } from './types';

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -\/]*[@-~]/g;
const THREADTIME = /^(?:(\d{2}-\d{2})\s+)?(\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]+):\s?(.*)$/;
const BRIEF = /^([VDIWEF])\/([^\s(]+)\s*\(\s*(\d+)\):\s?(.*)$/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function androidStudioLevel(value: unknown): LogLevel | undefined {
  switch (typeof value === 'string' ? value.toUpperCase() : '') {
    case 'V':
    case 'VERBOSE':
      return 'V';
    case 'D':
    case 'DEBUG':
      return 'D';
    case 'I':
    case 'INFO':
      return 'I';
    case 'W':
    case 'WARN':
    case 'WARNING':
      return 'W';
    case 'E':
    case 'ERROR':
      return 'E';
    case 'F':
    case 'FATAL':
    case 'ASSERT':
      return 'F';
    default:
      return undefined;
  }
}

function androidStudioTimestamp(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const seconds = asFiniteNumber(value.seconds);
  if (seconds === undefined) return undefined;
  const nanos = asFiniteNumber(value.nanos) ?? 0;
  const date = new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function cleanLine(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
}

function makeEvent(
  id: string,
  inputLine: number,
  values: {
    timestamp?: string;
    pid?: number;
    tid?: number;
    level: string;
    tag: string;
    message: string;
  },
  rawLine: string
): LogcatEvent {
  return {
    id,
    inputStartLine: inputLine,
    inputEndLine: inputLine,
    timestamp: values.timestamp,
    pid: values.pid,
    tid: values.tid,
    level: values.level as LogLevel,
    tag: values.tag.trim(),
    message: values.message,
    rawLines: [rawLine]
  };
}

/**
 * Android Studio's "Export Logcat" command writes a JSON object with a
 * `logcatMessages` array, rather than `adb logcat` text.  The first line of a
 * multi-line message is used for matching, which mirrors the text parser's
 * behaviour for stack-trace continuation lines; the complete message remains
 * available in `rawLines`.
 */
function parseAndroidStudioJson(text: string): LogcatEvent[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.logcatMessages)) {
    return undefined;
  }

  const events: LogcatEvent[] = [];
  for (const [index, value] of parsed.logcatMessages.entries()) {
    if (!isRecord(value) || !isRecord(value.header)) continue;
    const level = androidStudioLevel(value.header.logLevel);
    const tag = typeof value.header.tag === 'string' ? value.header.tag.trim() : '';
    const message = typeof value.message === 'string' ? value.message : '';
    if (!level || !tag) continue;

    const messageLines = message.replace(/\r\n?/g, '\n').split('\n');
    const event = makeEvent(
      `log-${events.length + 1}`,
      index + 1,
      {
        timestamp: androidStudioTimestamp(value.header.timestamp),
        pid: asFiniteNumber(value.header.pid),
        tid: asFiniteNumber(value.header.tid),
        level,
        tag,
        message: messageLines[0]
      },
      messageLines[0]
    );
    event.rawLines = messageLines;
    event.inputEndLine = index + 1;
    events.push(event);
  }

  return events;
}

/** Parses Android Studio JSON exports, `adb logcat -v threadtime`, and brief logcat format. */
export function parseLogcat(text: string): LogcatEvent[] {
  const androidStudioEvents = parseAndroidStudioJson(text);
  if (androidStudioEvents) {
    return androidStudioEvents;
  }

  const events: LogcatEvent[] = [];
  const lines = text.split(/\n/);
  let eventNumber = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].replace(/\r$/, '');
    const line = cleanLine(rawLine);
    if (!line || /^--------- beginning of /.test(line)) {
      continue;
    }

    const threadtime = line.match(THREADTIME);
    if (threadtime) {
      eventNumber += 1;
      events.push(
        makeEvent(
          `log-${eventNumber}`,
          index + 1,
          {
            timestamp: `${threadtime[1] ? `${threadtime[1]} ` : ''}${threadtime[2]}`,
            pid: Number(threadtime[3]),
            tid: Number(threadtime[4]),
            level: threadtime[5],
            tag: threadtime[6],
            message: threadtime[7]
          },
          rawLine
        )
      );
      continue;
    }

    const brief = line.match(BRIEF);
    if (brief) {
      eventNumber += 1;
      events.push(
        makeEvent(
          `log-${eventNumber}`,
          index + 1,
          {
            pid: Number(brief[3]),
            level: brief[1],
            tag: brief[2],
            message: brief[4]
          },
          rawLine
        )
      );
      continue;
    }

    const previous = events.at(-1);
    if (previous) {
      previous.rawLines.push(rawLine);
      previous.inputEndLine = index + 1;
    }
  }

  return events;
}

export function availablePids(events: LogcatEvent[]): number[] {
  return [...new Set(events.flatMap((event) => (event.pid === undefined ? [] : [event.pid])))].sort((a, b) => a - b);
}

export function availableTids(events: LogcatEvent[]): number[] {
  return [...new Set(events.flatMap((event) => (event.tid === undefined ? [] : [event.tid])))].sort((a, b) => a - b);
}
