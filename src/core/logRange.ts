import { LogcatEvent } from './types';

/**
 * Mapping a very large log all at once can make the extension host and the
 * webview unresponsive.  Keep the newest 10,000 physical input lines by
 * default; smaller logs are mapped in full.  Callers can always pass an
 * explicit range selected by the user.
 */
export const DEFAULT_LOG_MAPPING_LINE_LIMIT = 10_000;

/** A one-based, inclusive range of physical lines in the loaded log file. */
export interface LogLineRange {
  startLine: number;
  endLine: number;
}

/** Values directly usable from text/number inputs in a UI. */
export interface LogLineRangeInput {
  startLine?: number | string | null;
  endLine?: number | string | null;
}

function asPositiveInteger(value: number | string | null | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.floor(parsed));
}

function normalizedLineCount(totalLines: number): number {
  return Number.isFinite(totalLines) ? Math.max(0, Math.floor(totalLines)) : 0;
}

/**
 * Counts physical input lines without treating a final newline as an extra
 * blank line.  This matches the line numbers stored in `LogcatEvent`.
 */
export function countLogTextLines(text: string): number {
  if (!text) return 0;

  const normalized = text.replace(/\r\n/g, '\n');
  const newlineCount = (normalized.match(/\n/g) ?? []).length;
  return normalized.endsWith('\n') ? newlineCount : newlineCount + 1;
}

/**
 * Clamps a user-entered one-based line range to a loaded log.  Missing or
 * invalid endpoints mean the beginning/end of the log respectively; reversed
 * endpoints are reordered.  Empty logs have no selectable range.
 */
export function normalizeLogLineRange(
  totalLines: number,
  input: LogLineRangeInput = {}
): LogLineRange | undefined {
  const total = normalizedLineCount(totalLines);
  if (total === 0) return undefined;

  const requestedStart = asPositiveInteger(input.startLine) ?? 1;
  const requestedEnd = asPositiveInteger(input.endLine) ?? total;
  const startLine = Math.min(total, requestedStart);
  const endLine = Math.min(total, requestedEnd);

  return startLine <= endLine
    ? { startLine, endLine }
    : { startLine: endLine, endLine: startLine };
}

/**
 * Returns a safe initial mapping selection.  It favours the newest log lines,
 * where active debugging normally occurs, and maps the complete file whenever
 * it fits within the limit.
 */
export function defaultLogMappingRange(
  totalLines: number,
  lineLimit = DEFAULT_LOG_MAPPING_LINE_LIMIT
): LogLineRange | undefined {
  const total = normalizedLineCount(totalLines);
  if (total === 0) return undefined;

  const safeLimit = Number.isFinite(lineLimit) ? Math.max(1, Math.floor(lineLimit)) : DEFAULT_LOG_MAPPING_LINE_LIMIT;
  return {
    startLine: Math.max(1, total - safeLimit + 1),
    endLine: total
  };
}

/**
 * A logcat event is selected by the line containing its actual log header.
 * Continuation/stack-trace lines remain attached to that event but do not
 * create separately mappable events.
 */
export function isLogcatEventInLineRange(event: Pick<LogcatEvent, 'inputStartLine'>, range: LogLineRange): boolean {
  return event.inputStartLine >= range.startLine && event.inputStartLine <= range.endLine;
}

/** Returns events whose log header falls inside the selected physical line range. */
export function filterLogcatEventsByLineRange(
  events: readonly LogcatEvent[],
  range: LogLineRange | undefined
): LogcatEvent[] {
  if (!range) return [];
  return events.filter((event) => isLogcatEventInLineRange(event, range));
}
