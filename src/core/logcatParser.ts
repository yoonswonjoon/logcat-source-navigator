import { LogLevel, LogcatEvent } from './types';

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -\/]*[@-~]/g;
const DIVIDER_LINE = /^--------- beginning of /;
const MAX_DIAGNOSTICS = 25;

// `adb logcat -v threadtime` normally starts with `MM-DD`, but copied/exported
// .log files commonly expand it to `YYYY-MM-DD`. Some tools also use `T` as
// the date/time separator.
const THREADTIME = /^\s*(?:(?<date>\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:\s+|T))?(?<time>\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEF])\s+(?<tag>[^:]+):\s?(?<message>.*)$/;
const BRIEF = /^(?<level>[VDIWEF])\/(?<tag>[^\s(]+)\s*\(\s*(?<pid>\d+)\):\s?(?<message>.*)$/;

/**
 * Common text representations supported without a custom profile.
 *
 * `auto` first detects Android Studio JSON exports, then recognises each text
 * line independently. This is intentionally tolerant of a file that contains
 * more than one text format.
 */
export type BuiltInLogFormat = 'auto' | 'threadtime' | 'brief' | 'vendorPidTid' | 'androidStudioJson';

/** A concrete parser that was used for a parse result. */
export type ResolvedLogFormat = Exclude<BuiltInLogFormat, 'auto'> | 'custom' | 'unknown';

/**
 * A line-oriented parser profile for vendor text / .log files.
 *
 * `pattern` must use JavaScript named capture groups. `level`, `tag`, and
 * `message` are required. `timestamp`, or the `date` + `time` pair, and the
 * numeric `pid` / `tid` groups are optional. An optional `process` or
 * `package` group is retained as `LogcatEvent.process` for filtering/display
 * purposes.
 */
export interface CustomRegexLogFormatProfile {
  /** Friendly label for UI storage and display. It does not affect parsing. */
  name?: string;
  /** JavaScript regular-expression source, without surrounding `/` delimiters. */
  pattern: string;
  /** Optional JavaScript flags. `g` and `y` are ignored because matching is per line. */
  flags?: string;
}

/**
 * Select a built-in parser, or pass a custom regex profile. The string form is
 * convenient for a select box: `parseLogcatWithFormat(text, 'vendorPidTid')`.
 */
export type LogFormatSelection =
  | BuiltInLogFormat
  | {
      format: 'custom';
      profile: CustomRegexLogFormatProfile;
    };

export type LogcatParseDiagnosticCode =
  | 'INVALID_ANDROID_STUDIO_JSON'
  | 'NOT_ANDROID_STUDIO_JSON'
  | 'INVALID_CUSTOM_REGEX'
  | 'MISSING_CUSTOM_GROUPS'
  | 'IGNORED_CUSTOM_REGEX_FLAGS'
  | 'INVALID_CUSTOM_LEVEL'
  | 'INVALID_CUSTOM_PID'
  | 'INVALID_CUSTOM_TID'
  | 'NO_LOG_EVENTS';

export interface LogcatParseDiagnostic {
  severity: 'warning' | 'error';
  code: LogcatParseDiagnosticCode;
  message: string;
  /** One-based source line for text formats, when applicable. */
  line?: number;
}

/**
 * Detailed counterpart to the backward-compatible `parseLogcat` API.
 * `diagnostics` is capped so a malformed multi-megabyte file cannot flood the
 * webview or extension host.
 */
export interface LogcatParseResult {
  events: LogcatEvent[];
  selectedFormat: BuiltInLogFormat | 'custom';
  chosenFormat: ResolvedLogFormat;
  parsedEventCount: number;
  inputLineCount: number;
  diagnostics: LogcatParseDiagnostic[];
}

type JsonRecord = Record<string, unknown>;

interface EventValues {
  timestamp?: string;
  pid?: number;
  tid?: number;
  process?: string;
  level: LogLevel;
  tag: string;
  message: string;
}

interface ParsedTextHeader {
  format: Exclude<ResolvedLogFormat, 'unknown'>;
  values: EventValues;
}

type TextHeaderParser = (line: string, inputLine: number, diagnostics: LogcatParseDiagnostic[]) => ParsedTextHeader | undefined;

interface TextParseOutput {
  events: LogcatEvent[];
  formatCounts: Map<Exclude<ResolvedLogFormat, 'unknown'>, number>;
}

interface AndroidStudioJsonAttempt {
  kind: 'parsed' | 'invalidJson' | 'notAndroidStudioJson';
  events: LogcatEvent[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseNumericId(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const number = Number(trimmed);
  return Number.isSafeInteger(number) ? number : undefined;
}

function toLogLevel(value: unknown): LogLevel | undefined {
  switch (typeof value === 'string' ? value.trim().toUpperCase() : '') {
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

function inputLineCount(text: string): number {
  if (!text) return 0;
  const withoutFinalNewline = text.replace(/(?:\r?\n)$/, '');
  return withoutFinalNewline ? withoutFinalNewline.split(/\r?\n/).length : 0;
}

function addDiagnostic(
  diagnostics: LogcatParseDiagnostic[],
  diagnostic: LogcatParseDiagnostic
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}

function makeEvent(
  id: string,
  inputLine: number,
  values: EventValues,
  rawLine: string
): LogcatEvent {
  return {
    id,
    inputStartLine: inputLine,
    inputEndLine: inputLine,
    timestamp: values.timestamp,
    pid: values.pid,
    tid: values.tid,
    process: values.process,
    level: values.level,
    tag: values.tag.trim(),
    message: values.message,
    rawLines: [rawLine]
  };
}

function timestampFromGroups(groups: Record<string, string | undefined>): string | undefined {
  const timestamp = groups.timestamp?.trim();
  if (timestamp) return timestamp;

  const date = groups.date?.trim();
  const time = groups.time?.trim();
  if (date && time) return `${date} ${time}`;
  return date || time;
}

function headerFromGroups(
  groups: Record<string, string | undefined>,
  format: Exclude<ResolvedLogFormat, 'unknown'>
): ParsedTextHeader | undefined {
  const level = toLogLevel(groups.level);
  const tag = groups.tag?.trim();
  if (!level || !tag || groups.message === undefined) return undefined;

  const process = groups.process?.trim();
  return {
    format,
    values: {
      timestamp: timestampFromGroups(groups),
      pid: parseNumericId(groups.pid),
      tid: parseNumericId(groups.tid),
      process: process || undefined,
      level,
      tag,
      message: groups.message
    }
  };
}

function parseThreadtimeHeader(line: string): ParsedTextHeader | undefined {
  const match = THREADTIME.exec(line);
  return match?.groups ? headerFromGroups(match.groups, 'threadtime') : undefined;
}

function parseBriefHeader(line: string): ParsedTextHeader | undefined {
  const match = BRIEF.exec(line);
  return match?.groups ? headerFromGroups(match.groups, 'brief') : undefined;
}

/**
 * Common vendor text variant, e.g.
 * `2026-08-04 10:00:00.000 3616-3616 I HMG-RotaryController: message`.
 *
 * It deliberately accepts spaces around `-`, and `I/tag:` in addition to
 * `I tag:`, because both appear in copied vendor logs.
 */
const VENDOR_PID_TID = /^\s*(?:(?<date>\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:\s+|T))?(?<time>\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)\s+(?<pid>\d+)\s*-\s*(?<tid>\d+)\s+(?<level>[VDIWEF])(?:\/|\s+)(?<tag>[^:]+):\s?(?<message>.*)$/;

function parseVendorPidTidHeader(line: string): ParsedTextHeader | undefined {
  const match = VENDOR_PID_TID.exec(line);
  return match?.groups ? headerFromGroups(match.groups, 'vendorPidTid') : undefined;
}

function parseTextLog(
  text: string,
  parsers: readonly TextHeaderParser[],
  diagnostics: LogcatParseDiagnostic[]
): TextParseOutput {
  const events: LogcatEvent[] = [];
  const formatCounts = new Map<Exclude<ResolvedLogFormat, 'unknown'>, number>();
  const lines = text.split(/\n/);
  let eventNumber = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].replace(/\r$/, '');
    const line = cleanLine(rawLine);
    if (!line || DIVIDER_LINE.test(line)) {
      continue;
    }

    let parsed: ParsedTextHeader | undefined;
    for (const parser of parsers) {
      parsed = parser(line, index + 1, diagnostics);
      if (parsed) break;
    }

    if (parsed) {
      eventNumber += 1;
      events.push(makeEvent(`log-${eventNumber}`, index + 1, parsed.values, rawLine));
      formatCounts.set(parsed.format, (formatCounts.get(parsed.format) ?? 0) + 1);
      continue;
    }

    // Match the existing parser's behaviour: non-header rows belong to the
    // preceding event. This keeps stack traces and vendor multi-line messages
    // together for both built-in and custom formats.
    const previous = events.at(-1);
    if (previous) {
      previous.rawLines.push(rawLine);
      previous.inputEndLine = index + 1;
    }
  }

  return { events, formatCounts };
}

function selectMostFrequentFormat(
  formatCounts: ReadonlyMap<Exclude<ResolvedLogFormat, 'unknown'>, number>
): ResolvedLogFormat {
  let chosen: ResolvedLogFormat = 'unknown';
  let highestCount = 0;
  for (const [format, count] of formatCounts) {
    if (count > highestCount) {
      chosen = format;
      highestCount = count;
    }
  }
  return chosen;
}

function textResult(
  text: string,
  selectedFormat: BuiltInLogFormat | 'custom',
  parsers: readonly TextHeaderParser[],
  diagnostics: LogcatParseDiagnostic[],
  fallbackFormat: ResolvedLogFormat
): LogcatParseResult {
  const output = parseTextLog(text, parsers, diagnostics);
  const chosenFormat = selectedFormat === 'auto' ? selectMostFrequentFormat(output.formatCounts) : fallbackFormat;
  if (output.events.length === 0 && text.trim()) {
    addDiagnostic(diagnostics, {
      severity: 'warning',
      code: 'NO_LOG_EVENTS',
      message: 'No log headers matched the selected format.'
    });
  }
  return {
    events: output.events,
    selectedFormat,
    chosenFormat,
    parsedEventCount: output.events.length,
    inputLineCount: inputLineCount(text),
    diagnostics
  };
}

/**
 * Android Studio's "Export Logcat" command writes a JSON object with a
 * `logcatMessages` array, rather than `adb logcat` text. The first line of a
 * multi-line message is used for matching, which mirrors the text parser's
 * behaviour for stack-trace continuation lines; the complete message remains
 * available in `rawLines`.
 */
function tryParseAndroidStudioJson(text: string): AndroidStudioJsonAttempt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalidJson', events: [] };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.logcatMessages)) {
    return { kind: 'notAndroidStudioJson', events: [] };
  }

  const events: LogcatEvent[] = [];
  for (const [index, value] of parsed.logcatMessages.entries()) {
    if (!isRecord(value) || !isRecord(value.header)) continue;
    const level = toLogLevel(value.header.logLevel);
    const tag = typeof value.header.tag === 'string' ? value.header.tag.trim() : '';
    const message = typeof value.message === 'string' ? value.message : '';
    if (!level || !tag) continue;

    const messageLines = message.replace(/\r\n?/g, '\n').split('\n');
    const processValue = value.header.process ?? value.header.processName ?? value.header.applicationId;
    const event = makeEvent(
      `log-${events.length + 1}`,
      index + 1,
      {
        timestamp: androidStudioTimestamp(value.header.timestamp),
        pid: asFiniteNumber(value.header.pid),
        tid: asFiniteNumber(value.header.tid),
        process: typeof processValue === 'string' && processValue.trim() ? processValue.trim() : undefined,
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

  return { kind: 'parsed', events };
}

function namedGroupNames(pattern: string): Set<string> {
  const names = new Set<string>();
  const matcher = /\(\?<([A-Za-z_$][\w$]*)>/g;
  for (const match of pattern.matchAll(matcher)) {
    names.add(match[1]);
  }
  return names;
}

function customParser(
  profile: CustomRegexLogFormatProfile,
  diagnostics: LogcatParseDiagnostic[]
): TextHeaderParser | undefined {
  const originalFlags = profile.flags ?? '';
  const flags = originalFlags.replace(/[gy]/g, '');
  if (flags !== originalFlags) {
    addDiagnostic(diagnostics, {
      severity: 'warning',
      code: 'IGNORED_CUSTOM_REGEX_FLAGS',
      message: 'Custom regex flags g and y are ignored because the profile matches one line at a time.'
    });
  }

  let regex: RegExp;
  try {
    regex = new RegExp(profile.pattern, flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addDiagnostic(diagnostics, {
      severity: 'error',
      code: 'INVALID_CUSTOM_REGEX',
      message: `Custom regex could not be compiled: ${reason}`
    });
    return undefined;
  }

  const requiredGroups = ['level', 'tag', 'message'];
  const missingGroups = requiredGroups.filter((group) => !namedGroupNames(profile.pattern).has(group));
  if (missingGroups.length > 0) {
    addDiagnostic(diagnostics, {
      severity: 'error',
      code: 'MISSING_CUSTOM_GROUPS',
      message: `Custom regex needs named groups: ${missingGroups.join(', ')}.`
    });
    return undefined;
  }

  return (line, inputLine, parserDiagnostics) => {
    const match = regex.exec(line);
    if (!match?.groups) return undefined;

    const level = toLogLevel(match.groups.level);
    if (!level) {
      addDiagnostic(parserDiagnostics, {
        severity: 'warning',
        code: 'INVALID_CUSTOM_LEVEL',
        message: `Custom regex captured an unsupported level "${match.groups.level ?? ''}".`,
        line: inputLine
      });
      return undefined;
    }

    const tag = match.groups.tag?.trim();
    if (!tag || match.groups.message === undefined) {
      return undefined;
    }

    const pid = parseNumericId(match.groups.pid);
    if (match.groups.pid?.trim() && pid === undefined) {
      addDiagnostic(parserDiagnostics, {
        severity: 'warning',
        code: 'INVALID_CUSTOM_PID',
        message: `Custom regex captured a non-numeric pid "${match.groups.pid}".`,
        line: inputLine
      });
    }

    const tid = parseNumericId(match.groups.tid);
    if (match.groups.tid?.trim() && tid === undefined) {
      addDiagnostic(parserDiagnostics, {
        severity: 'warning',
        code: 'INVALID_CUSTOM_TID',
        message: `Custom regex captured a non-numeric tid "${match.groups.tid}".`,
        line: inputLine
      });
    }

    const process = match.groups.process?.trim() || match.groups.package?.trim();
    return {
      format: 'custom',
      values: {
        timestamp: timestampFromGroups(match.groups),
        pid,
        tid,
        process: process || undefined,
        level,
        tag,
        message: match.groups.message
      }
    };
  };
}

function androidStudioResult(
  text: string,
  selectedFormat: BuiltInLogFormat,
  diagnostics: LogcatParseDiagnostic[]
): LogcatParseResult {
  const jsonResult = tryParseAndroidStudioJson(text);
  if (jsonResult.kind === 'parsed') {
    return {
      events: jsonResult.events,
      selectedFormat,
      chosenFormat: 'androidStudioJson',
      parsedEventCount: jsonResult.events.length,
      inputLineCount: inputLineCount(text),
      diagnostics
    };
  }

  addDiagnostic(diagnostics, {
    severity: 'error',
    code: jsonResult.kind === 'invalidJson' ? 'INVALID_ANDROID_STUDIO_JSON' : 'NOT_ANDROID_STUDIO_JSON',
    message:
      jsonResult.kind === 'invalidJson'
        ? 'The selected Android Studio JSON format could not be parsed as JSON.'
        : 'The selected Android Studio JSON format does not contain a logcatMessages array.'
  });
  return {
    events: [],
    selectedFormat,
    chosenFormat: 'androidStudioJson',
    parsedEventCount: 0,
    inputLineCount: inputLineCount(text),
    diagnostics
  };
}

/**
 * Parses a log export using a selected built-in format or named-group custom
 * regex profile. The returned diagnostics are intended for a format-picker UI.
 */
export function parseLogcatWithFormat(
  text: string,
  selection: LogFormatSelection = 'auto'
): LogcatParseResult {
  // A UTF-8 BOM is fairly common in text exports saved by Windows tools. It
  // must be removed before the first header, including a JSON export.
  const normalizedText = text.replace(/^\uFEFF/, '');
  const diagnostics: LogcatParseDiagnostic[] = [];

  if (typeof selection !== 'string') {
    const parser = customParser(selection.profile, diagnostics);
    if (!parser) {
      return {
        events: [],
        selectedFormat: 'custom',
        chosenFormat: 'custom',
        parsedEventCount: 0,
        inputLineCount: inputLineCount(normalizedText),
        diagnostics
      };
    }
    return textResult(normalizedText, 'custom', [parser], diagnostics, 'custom');
  }

  switch (selection) {
    case 'androidStudioJson':
      return androidStudioResult(normalizedText, selection, diagnostics);
    case 'threadtime':
      return textResult(normalizedText, selection, [parseThreadtimeHeader], diagnostics, 'threadtime');
    case 'brief':
      return textResult(normalizedText, selection, [parseBriefHeader], diagnostics, 'brief');
    case 'vendorPidTid':
      return textResult(normalizedText, selection, [parseVendorPidTidHeader], diagnostics, 'vendorPidTid');
    case 'auto': {
      // JSON parsing is only attempted as a format choice when it succeeds.
      // A normal text log should not display a misleading JSON error.
      const jsonResult = tryParseAndroidStudioJson(normalizedText);
      if (jsonResult.kind === 'parsed') {
        return {
          events: jsonResult.events,
          selectedFormat: 'auto',
          chosenFormat: 'androidStudioJson',
          parsedEventCount: jsonResult.events.length,
          inputLineCount: inputLineCount(normalizedText),
          diagnostics
        };
      }
      return textResult(
        normalizedText,
        'auto',
        [parseThreadtimeHeader, parseVendorPidTidHeader, parseBriefHeader],
        diagnostics,
        'unknown'
      );
    }
  }
}

/**
 * Backward-compatible automatic parser used by the existing extension flow.
 * New callers that need format diagnostics should use `parseLogcatWithFormat`.
 */
export function parseLogcat(text: string): LogcatEvent[] {
  return parseLogcatWithFormat(text, 'auto').events;
}

export function availablePids(events: LogcatEvent[]): number[] {
  return [...new Set(events.flatMap((event) => (event.pid === undefined ? [] : [event.pid])))].sort((a, b) => a - b);
}

export function availableTids(events: LogcatEvent[]): number[] {
  return [...new Set(events.flatMap((event) => (event.tid === undefined ? [] : [event.tid])))].sort((a, b) => a - b);
}
