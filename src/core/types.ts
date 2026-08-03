export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F';

export type LoggerApi = 'Log' | 'Slog' | 'ALOG' | 'android_log_print';

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

export interface SourceIndexOptions {
  excludeDirectoryNames: string[];
  maxFileSizeBytes: number;
}
