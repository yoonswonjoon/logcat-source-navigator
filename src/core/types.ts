export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F';

export type LoggerApi = 'Log' | 'Slog' | 'ALOG' | 'android_log_print' | 'Custom';

export type TemplateSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'dynamic' };

export interface MessageTemplate {
  segments: TemplateSegment[];
  staticChars: number;
  isLiteralOnly: boolean;
  preview: string;
}

export interface SourceLocation {
  filePath: string;
  relativePath: string;
  line: number;
  column: number;
  functionName?: string;
  sourcePreview: string;
}

export interface SourceLogSite extends SourceLocation {
  id: string;
  api: LoggerApi;
  level: LogLevel;
  tag?: string;
  template: MessageTemplate;
}

export interface SourceIndex {
  version: number;
  roots: string[];
  createdAt: string;
  sites: SourceLogSite[];
}

export interface LogcatEvent {
  id: string;
  inputStartLine: number;
  inputEndLine: number;
  timestamp?: string;
  pid?: number;
  tid?: number;
  /**
   * Optional process / package column provided by some vendor log formats.
   * Standard logcat formats do not always include it, so callers must treat it
   * as advisory metadata rather than a required filter key.
   */
  process?: string;
  level: LogLevel;
  tag: string;
  message: string;
  rawLines: string[];
}

export type MatchStatus = 'exact' | 'pattern' | 'ambiguous' | 'low' | 'unmatched';

export interface MatchCandidate {
  site: SourceLogSite;
  score: number;
  reason: string[];
}

export interface MappedLogEvent {
  event: LogcatEvent;
  status: MatchStatus;
  candidates: MatchCandidate[];
}

export interface IndexProgress {
  scannedFiles: number;
  indexedSites: number;
  currentPath?: string;
}

/**
 * Describes a project-specific Java/Kotlin logging facade.
 *
 * For example, `{ receiver: 'L' }` indexes `L.d(...)`, `L.e(...)`, and the
 * other Android log-level methods.  When the argument indices are omitted,
 * the indexer supports the common wrapper forms `L.e(message)`,
 * `L.e(message, throwable)`, and `L.e(tag, message[, throwable])`.
 *
 * Set both indices for a wrapper with a non-standard signature, such as
 * `Audit.e(error, tag, message)`.
 */
export interface CustomLoggerDefinition {
  /** Receiver expression to recognize, such as `L` or `com.example.Trace`. */
  receiver: string;
  /** Zero-based argument containing the log tag. */
  tagArgumentIndex?: number;
  /** Zero-based argument containing the log message. */
  messageArgumentIndex?: number;
}

export interface SourceIndexOptions {
  excludeDirectoryNames: string[];
  maxFileSizeBytes: number;
  /** Project-specific Java/Kotlin logging facades to index in addition to Log/Slog. */
  customLoggers?: CustomLoggerDefinition[];
}
