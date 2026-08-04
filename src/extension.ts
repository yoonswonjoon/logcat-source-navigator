import path from 'node:path';
import * as vscode from 'vscode';
import { SourceIndexStore } from './core/indexStore';
import { searchSourceLogSites } from './core/indexSearch';
import {
  countLogTextLines,
  defaultLogMappingRange,
  filterLogcatEventsByLineRange,
  LogLineRange,
  normalizeLogLineRange
} from './core/logRange';
import {
  availablePids,
  availableTids,
  LogFormatSelection,
  parseLogcatWithFormat,
  ResolvedLogFormat
} from './core/logcatParser';
import { filterMappedEvents, isAutomaticallyNavigable, LogFilter, matchLogcatEvents } from './core/matcher';
import { buildSourceIndex } from './core/sourceIndexer';
import {
  CustomLoggerDefinition,
  LogcatEvent,
  MappedLogEvent,
  MatchCandidate,
  SourceIndex,
  SourceLogSite
} from './core/types';
import {
  PanelIndexedLogRow,
  PanelLogFormatId,
  LogcatSourceViewProvider,
  PanelFilters,
  PanelLogRow,
  PanelMessage,
  PanelState
} from './webview/logcatSourceView';

const VIEW_ID = 'logcatSourceNavigator.logView';
const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const MAX_PANEL_LOG_ROWS = 2_000;
const LOG_FORMAT_STORAGE_KEY = 'logcatSourceNavigator.logFormat';
const LOG_FORMAT_IDS: PanelLogFormatId[] = ['auto', 'androidStudioJson', 'threadtime', 'brief', 'vendorPidTid', 'custom'];
const LOG_FORMAT_LABELS: Record<PanelLogFormatId | ResolvedLogFormat, string> = {
  auto: 'Auto',
  androidStudioJson: 'Android Studio JSON',
  threadtime: 'Threadtime',
  brief: 'Brief',
  vendorPidTid: 'Vendor PID-TID',
  custom: 'Custom regex',
  unknown: 'Unknown text format'
};

interface StoredLogFormat {
  selectedId?: unknown;
  customName?: unknown;
  customPattern?: unknown;
}

function normalizeLogFormatId(value: unknown): PanelLogFormatId {
  return typeof value === 'string' && LOG_FORMAT_IDS.includes(value as PanelLogFormatId)
    ? value as PanelLogFormatId
    : 'auto';
}

function normalizeCustomFormatName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'Workspace custom format';
}

function normalizeCustomFormatPattern(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 8_000) : '';
}

function logFormatLabel(format: PanelLogFormatId | ResolvedLogFormat): string {
  return LOG_FORMAT_LABELS[format];
}

function normalizeIdFilter(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0))].sort(
    (left, right) => left - right
  );
}

function normalizeCustomLoggers(value: unknown): CustomLoggerDefinition[] {
  if (!Array.isArray(value)) return [];

  const normalized: CustomLoggerDefinition[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const definition = entry as Record<string, unknown>;
    const receiver = typeof definition.receiver === 'string' ? definition.receiver.trim() : '';
    if (!receiver) continue;

    const tagArgumentIndex = definition.tagArgumentIndex;
    const messageArgumentIndex = definition.messageArgumentIndex;
    normalized.push({
      receiver,
      ...(typeof tagArgumentIndex === 'number' && Number.isInteger(tagArgumentIndex) && tagArgumentIndex >= 0
        ? { tagArgumentIndex }
        : {}),
      ...(typeof messageArgumentIndex === 'number' && Number.isInteger(messageArgumentIndex) && messageArgumentIndex >= 0
        ? { messageArgumentIndex }
        : {})
    });
  }
  return normalized;
}

class LogcatSourceController implements vscode.Disposable {
  private readonly store: SourceIndexStore;
  private readonly viewProvider: LogcatSourceViewProvider;
  private readonly sourceDecoration: vscode.TextEditorDecorationType;
  private sourceIndex?: SourceIndex;
  private logcatEvents: LogcatEvent[] = [];
  private mappedEvents: MappedLogEvent[] = [];
  private displayedEvents: MappedLogEvent[] = [];
  private filteredEventCount = 0;
  private panelLogRowsTruncated = false;
  private selectedId?: string;
  private loadedLogcatName?: string;
  private logcatLineCount = 0;
  private mappingLineRange?: LogLineRange;
  private logcatPids: number[] = [];
  private logcatTids: number[] = [];
  private loadedLogcatUri?: vscode.Uri;
  private loadedLogcatText?: string;
  private logFormatId: PanelLogFormatId = 'auto';
  private customFormatName = 'Workspace custom format';
  private customFormatPattern = '';
  private parsedFormat?: string;
  private logFormatError?: string;
  private indexedLogsVisible = false;
  private indexedLogsQuery = '';
  private lastEditor?: vscode.TextEditor;
  private notice?: string;
  private filters: PanelFilters = {
    levels: [...LEVELS],
    query: '',
    mappedOnly: false
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new SourceIndexStore(context.globalStorageUri.fsPath);
    this.viewProvider = new LogcatSourceViewProvider((message) => {
      void this.handleMessage(message);
    });
    this.sourceDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground')
    });
  }

  async initialize(): Promise<void> {
    const storedFormat = this.context.workspaceState.get<StoredLogFormat>(LOG_FORMAT_STORAGE_KEY);
    this.logFormatId = normalizeLogFormatId(storedFormat?.selectedId);
    this.customFormatName = normalizeCustomFormatName(storedFormat?.customName);
    this.customFormatPattern = normalizeCustomFormatPattern(storedFormat?.customPattern);
    this.sourceIndex = await this.store.load();
    if (this.sourceIndex) {
      this.notice = `Loaded cached index with ${this.sourceIndex.sites.length} source logs.`;
    }
    this.refreshMappings();
  }

  get provider(): LogcatSourceViewProvider {
    return this.viewProvider;
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async browseIndexedLogs(): Promise<void> {
    await this.focus();
    this.indexedLogsVisible = true;
    this.postState();
  }

  async indexSources(): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Index selected source folder'
    });
    const root = selection?.[0];
    if (!root) return;
    if (root.scheme !== 'file') {
      void vscode.window.showErrorMessage('This MVP currently indexes local source folders only.');
      return;
    }

    const config = vscode.workspace.getConfiguration('logcatSourceNavigator');
    const excludeDirectoryNames = config.get<string[]>('exclude', []);
    const maxFileSizeKb = config.get<number>('maxFileSizeKb', 2048);
    const customLoggers = normalizeCustomLoggers(config.get<unknown>('customLoggers', []));
    this.notice = `Indexing ${root.fsPath}...`;
    this.postState();

    try {
      this.sourceIndex = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Logcat Source: indexing source logs',
          cancellable: false
        },
        async (progress) =>
          buildSourceIndex(
            [root.fsPath],
            {
              excludeDirectoryNames,
              maxFileSizeBytes: maxFileSizeKb * 1024,
              customLoggers
            },
            (scannedFiles, indexedSites, currentPath) => {
              if (scannedFiles % 25 === 0) {
                progress.report({
                  message: `${scannedFiles} files / ${indexedSites} logs`,
                  increment: 1
                });
              }
              this.notice = `Indexing ${path.basename(currentPath)} (${scannedFiles} files / ${indexedSites} logs)`;
            }
          )
      );
      await this.store.save(this.sourceIndex);
      this.notice = `Indexed ${this.sourceIndex.sites.length} source logs from ${path.basename(root.fsPath)}${customLoggers.length ? ` with ${customLoggers.length} custom logger definition${customLoggers.length === 1 ? '' : 's'}` : ''}.`;
      this.refreshMappings();
      void vscode.window.showInformationMessage(this.notice);
    } catch (error) {
      this.notice = `Indexing failed: ${error instanceof Error ? error.message : String(error)}`;
      this.postState();
      void vscode.window.showErrorMessage(this.notice);
    }
  }

  async loadLogcat(): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'Logcat and text files': ['log', 'logcat', 'txt', 'json'],
        'All files': ['*']
      },
      openLabel: 'Load logcat'
    });
    const file = selection?.[0];
    if (!file) return;

    await this.loadLogcatUri(file);
  }

  /**
   * Handles the native picker as well as a file URI received from a webview
   * drop.  The latter is important on VS Code/Electron builds that expose an
   * external drag as `text/uri-list` instead of a browser File object.
   */
  async loadLogcatUri(uri: vscode.Uri): Promise<void> {
    const name = path.basename(uri.fsPath || uri.path) || 'logcat';
    this.notice = `Loading ${name}...`;
    this.postState();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.loadedLogcatUri = uri;
      this.loadedLogcatText = undefined;
      this.applyLoadedLogcatText(name, Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      this.notice = `Unable to load ${name}: ${error instanceof Error ? error.message : String(error)}`;
      this.postState();
      void vscode.window.showErrorMessage(this.notice);
    }
  }

  async loadLogcatUriString(uriText: string): Promise<void> {
    if (typeof uriText !== 'string' || !uriText.trim()) {
      void vscode.window.showErrorMessage('Unable to load dropped logcat: no file URI was provided.');
      return;
    }

    try {
      const uri = vscode.Uri.parse(uriText.trim(), true);
      if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
        throw new Error('The dropped value is not a local or remote workspace file URI.');
      }
      await this.loadLogcatUri(uri);
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to load dropped logcat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  loadLogcatText(name: string, text: string): void {
    // Webview drop events do not reliably expose a reusable file URI. Keep
    // their text for this session so changing the format can reparse it.
    this.loadedLogcatUri = undefined;
    this.loadedLogcatText = text;
    this.applyLoadedLogcatText(name, text);
  }

  private applyLoadedLogcatText(name: string, text: string, preserveRange = false): void {
    const previousRange = preserveRange ? this.mappingLineRange : undefined;
    const result = parseLogcatWithFormat(text, this.currentLogFormatSelection());
    this.logcatEvents = result.events;
    this.loadedLogcatName = name;
    const highestEventLine = this.logcatEvents.reduce((highest, event) => Math.max(highest, event.inputEndLine), 0);
    this.logcatLineCount = Math.max(result.inputLineCount, countLogTextLines(text), highestEventLine);
    this.mappingLineRange = previousRange
      ? normalizeLogLineRange(this.logcatLineCount, previousRange)
      : defaultLogMappingRange(this.logcatLineCount);
    this.logcatPids = availablePids(this.logcatEvents);
    this.logcatTids = availableTids(this.logcatEvents);
    this.selectedId = undefined;
    this.clearDecoration();
    this.filters = {
      ...this.filters,
      pids: undefined,
      tids: undefined
    };
    this.logFormatError = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message;
    this.parsedFormat = this.describeParsedFormat(result.chosenFormat);
    const rangeText = this.mappingLineRange
      ? `${this.mappingLineRange.startLine}–${this.mappingLineRange.endLine} of ${this.logcatLineCount}`
      : undefined;
    const parseMessage = this.logFormatError ?? result.diagnostics.at(0)?.message;
    this.notice = this.logcatEvents.length
      ? `Loaded ${this.logcatEvents.length} ${this.parsedFormat} events. Mapping input lines ${rangeText}.`
      : (parseMessage ?? `No log headers matched ${this.describeSelectedFormat()}. Try Auto or Custom regex.`);
    this.refreshMappings();
  }

  private currentLogFormatSelection(): LogFormatSelection {
    if (this.logFormatId === 'custom') {
      return {
        format: 'custom',
        profile: {
          name: this.customFormatName,
          pattern: this.customFormatPattern
        }
      };
    }
    return this.logFormatId;
  }

  private describeSelectedFormat(): string {
    return this.logFormatId === 'custom' ? this.customFormatName : logFormatLabel(this.logFormatId);
  }

  private describeParsedFormat(format: ResolvedLogFormat): string {
    if (this.logFormatId === 'auto' && format !== 'unknown') {
      return `Auto: ${logFormatLabel(format)}`;
    }
    return format === 'custom' ? this.customFormatName : logFormatLabel(format);
  }

  private async persistLogFormat(): Promise<void> {
    await this.context.workspaceState.update(LOG_FORMAT_STORAGE_KEY, {
      selectedId: this.logFormatId,
      customName: this.customFormatName,
      customPattern: this.customFormatPattern
    } satisfies StoredLogFormat);
  }

  async selectLogFormat(formatId: PanelLogFormatId): Promise<void> {
    this.logFormatId = normalizeLogFormatId(formatId);
    this.parsedFormat = undefined;
    this.logFormatError = undefined;
    await this.persistLogFormat();
    await this.reparseLoadedLogcat();
  }

  async applyCustomLogFormat(name: string, pattern: string): Promise<void> {
    this.customFormatName = normalizeCustomFormatName(name);
    this.customFormatPattern = normalizeCustomFormatPattern(pattern);
    this.logFormatId = 'custom';
    this.parsedFormat = undefined;
    this.logFormatError = undefined;
    await this.persistLogFormat();
    await this.reparseLoadedLogcat();
  }

  private async reparseLoadedLogcat(): Promise<void> {
    if (!this.loadedLogcatName) {
      if (this.logFormatId === 'custom') {
        const validation = parseLogcatWithFormat('', this.currentLogFormatSelection());
        this.logFormatError = validation.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message;
      }
      this.postState();
      return;
    }

    const name = this.loadedLogcatName;
    this.notice = `Reparsing ${name} as ${this.describeSelectedFormat()}...`;
    this.postState();
    try {
      if (this.loadedLogcatUri) {
        const bytes = await vscode.workspace.fs.readFile(this.loadedLogcatUri);
        this.applyLoadedLogcatText(name, Buffer.from(bytes).toString('utf8'), true);
        return;
      }
      if (this.loadedLogcatText !== undefined) {
        this.applyLoadedLogcatText(name, this.loadedLogcatText, true);
        return;
      }
      throw new Error('The original text is no longer available. Reload the log file.');
    } catch (error) {
      this.logFormatError = error instanceof Error ? error.message : String(error);
      this.notice = `Unable to reparse ${name}: ${this.logFormatError}`;
      this.postState();
    }
  }

  clearSession(): void {
    this.logcatEvents = [];
    this.mappedEvents = [];
    this.displayedEvents = [];
    this.filteredEventCount = 0;
    this.panelLogRowsTruncated = false;
    this.selectedId = undefined;
    this.loadedLogcatName = undefined;
    this.loadedLogcatUri = undefined;
    this.loadedLogcatText = undefined;
    this.logcatLineCount = 0;
    this.mappingLineRange = undefined;
    this.logcatPids = [];
    this.logcatTids = [];
    this.parsedFormat = undefined;
    this.logFormatError = undefined;
    this.notice = 'Cleared loaded logcat events. The source index is retained.';
    this.clearDecoration();
    this.postState();
  }

  setFilters(filters: PanelFilters): void {
    const levels = Array.isArray(filters.levels)
      ? filters.levels.filter((level): level is string => typeof level === 'string' && LEVELS.includes(level))
      : [...LEVELS];
    this.filters = {
      pids: normalizeIdFilter(filters.pids),
      tids: normalizeIdFilter(filters.tids),
      levels,
      query: typeof filters.query === 'string' ? filters.query : '',
      mappedOnly: Boolean(filters.mappedOnly)
    };
    this.selectedId = undefined;
    this.refreshMappings();
  }

  setMappingLineRange(startLine: number, endLine: number): void {
    const range = normalizeLogLineRange(this.logcatLineCount, { startLine, endLine });
    if (!range) return;
    this.mappingLineRange = range;
    this.selectedId = undefined;
    this.notice = `Mapping input lines ${range.startLine}–${range.endLine} of ${this.logcatLineCount}.`;
    this.refreshMappings();
  }

  selectLog(id: string): void {
    const mapped = this.displayedEvents.find((entry) => entry.event.id === id);
    if (!mapped) return;
    this.selectedId = id;
    if (isAutomaticallyNavigable(mapped)) {
      void this.navigateToCandidate(mapped.candidates[0]);
    }
    this.postState();
  }

  navigateMapped(delta: number): void {
    if (!this.displayedEvents.length) return;
    const start = Math.max(0, this.displayedEvents.findIndex((entry) => entry.event.id === this.selectedId));
    for (let offset = 1; offset <= this.displayedEvents.length; offset += 1) {
      const index = (start + delta * offset + this.displayedEvents.length) % this.displayedEvents.length;
      const candidate = this.displayedEvents[index];
      if (isAutomaticallyNavigable(candidate)) {
        this.selectLog(candidate.event.id);
        return;
      }
    }
  }

  openCandidate(eventId: string, candidateId: string): void {
    const mapped = this.displayedEvents.find((entry) => entry.event.id === eventId);
    const candidate = mapped?.candidates.find((entry) => entry.site.id === candidateId);
    if (!mapped || !candidate) return;
    this.selectedId = eventId;
    void this.navigateToCandidate(candidate);
    this.postState();
  }

  toggleIndexedLogs(): void {
    this.indexedLogsVisible = !this.indexedLogsVisible;
    this.postState();
  }

  setIndexedLogsQuery(query: string): void {
    this.indexedLogsQuery = typeof query === 'string' ? query.slice(0, 1000) : '';
    this.postState();
  }

  openIndexedLog(id: string): void {
    const site = this.sourceIndex?.sites.find((entry) => entry.id === id);
    if (!site) return;
    void this.navigateToSite(site);
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        return;
      case 'indexSources':
        await this.indexSources();
        return;
      case 'loadLogcat':
        await this.loadLogcat();
        return;
      case 'loadLogcatUri':
        await this.loadLogcatUriString(message.uri);
        return;
      case 'loadLogcatText':
        this.loadLogcatText(message.name, message.text);
        return;
      case 'loadLogcatError':
        void vscode.window.showErrorMessage(`Unable to load dropped logcat: ${message.message}`);
        return;
      case 'clearSession':
        this.clearSession();
        return;
      case 'selectLogFormat':
        await this.selectLogFormat(message.formatId);
        return;
      case 'applyCustomLogFormat':
        await this.applyCustomLogFormat(message.name, message.pattern);
        return;
      case 'applyLineRange':
        this.setMappingLineRange(message.startLine, message.endLine);
        return;
      case 'toggleIndexedLogs':
        this.toggleIndexedLogs();
        return;
      case 'filterIndexedLogs':
        this.setIndexedLogsQuery(message.query);
        return;
      case 'filter':
        this.setFilters(message.filters);
        return;
      case 'select':
        this.selectLog(message.id);
        return;
      case 'navigate':
        this.navigateMapped(message.delta);
        return;
      case 'openCandidate':
        this.openCandidate(message.eventId, message.candidateId);
        return;
      case 'openIndexedLog':
        this.openIndexedLog(message.id);
        return;
      default:
        return;
    }
  }

  private refreshMappings(): void {
    const rangedEvents = filterLogcatEventsByLineRange(this.logcatEvents, this.mappingLineRange);
    const preMatchEvents = rangedEvents.filter((event) => {
      if (this.filters.pids !== undefined && (event.pid === undefined || !this.filters.pids.includes(event.pid))) return false;
      if (this.filters.tids !== undefined && (event.tid === undefined || !this.filters.tids.includes(event.tid))) return false;
      return this.filters.levels.includes(event.level);
    });
    this.mappedEvents = matchLogcatEvents(preMatchEvents, this.sourceIndex?.sites ?? []);
    const filteredEvents = filterMappedEvents(this.mappedEvents, {
      query: this.filters.query,
      mappedOnly: this.filters.mappedOnly
    } satisfies LogFilter);
    this.filteredEventCount = filteredEvents.length;
    this.panelLogRowsTruncated = filteredEvents.length > MAX_PANEL_LOG_ROWS;
    // Rendering thousands of complete candidate lists can freeze a webview.
    // Navigation intentionally follows the same capped list; users can narrow
    // the input-line range or filters to inspect a different portion.
    this.displayedEvents = filteredEvents.slice(0, MAX_PANEL_LOG_ROWS);
    if (!this.displayedEvents.some((entry) => entry.event.id === this.selectedId)) {
      this.selectedId = undefined;
    }
    this.postState();
  }

  private getPanelState(): PanelState {
    const rows: PanelLogRow[] = this.displayedEvents.map((mapped) => ({
      id: mapped.event.id,
      timestamp: mapped.event.timestamp,
      pid: mapped.event.pid,
      tid: mapped.event.tid,
      process: mapped.event.process,
      level: mapped.event.level,
      tag: mapped.event.tag,
      message: mapped.event.message,
      status: mapped.status,
      candidates: mapped.candidates.map((candidate) => this.serializeCandidate(candidate))
    }));
    // Avoid scanning a large source index every time a log-row selection posts
    // state. The browser requests its capped search result only while open.
    const indexedLogSearch = this.indexedLogsVisible
      ? searchSourceLogSites(this.sourceIndex?.sites ?? [], this.indexedLogsQuery)
      : undefined;
    return {
      sourceRoots: this.sourceIndex?.roots ?? [],
      sourceSiteCount: this.sourceIndex?.sites.length ?? 0,
      indexCreatedAt: this.sourceIndex?.createdAt,
      loadedLogcatName: this.loadedLogcatName,
      totalEventCount: this.logcatEvents.length,
      displayedEventCount: this.filteredEventCount,
      renderedEventCount: rows.length,
      logRowsTruncated: this.panelLogRowsTruncated,
      lineRange: {
        totalLineCount: this.logcatLineCount,
        startLine: this.mappingLineRange?.startLine ?? 0,
        endLine: this.mappingLineRange?.endLine ?? 0
      },
      logFormat: {
        selectedId: this.logFormatId,
        customName: this.customFormatName,
        customPattern: this.customFormatPattern,
        parsedFormat: this.parsedFormat,
        parseError: this.logFormatError
      },
      pids: this.logcatPids,
      tids: this.logcatTids,
      filters: this.filters,
      rows,
      indexedLogs: {
        visible: this.indexedLogsVisible,
        query: this.indexedLogsQuery,
        matchedCount: indexedLogSearch?.matched ?? 0,
        rows: indexedLogSearch?.rows.map((site) => this.serializeIndexedLog(site)) ?? [],
        truncated: indexedLogSearch?.truncated ?? false
      },
      selectedId: this.selectedId,
      notice: this.notice
    };
  }

  private serializeCandidate(candidate: MatchCandidate): PanelLogRow['candidates'][number] {
    return {
      id: candidate.site.id,
      relativePath: candidate.site.relativePath,
      line: candidate.site.line,
      functionName: candidate.site.functionName,
      reason: candidate.reason.join(', ')
    };
  }

  private serializeIndexedLog(site: SourceLogSite): PanelIndexedLogRow {
    return {
      id: site.id,
      relativePath: site.relativePath,
      line: site.line,
      functionName: site.functionName,
      api: site.api,
      level: site.level,
      tag: site.tag,
      template: site.template.preview,
      sourcePreview: site.sourcePreview
    };
  }

  private postState(): void {
    this.viewProvider.postState(this.getPanelState());
  }

  private async navigateToCandidate(candidate: MatchCandidate): Promise<void> {
    await this.navigateToSite(candidate.site);
  }

  private async navigateToSite(site: SourceLogSite): Promise<void> {
    const position = new vscode.Position(Math.max(0, site.line - 1), site.column);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(site.filePath));
    const line = document.lineAt(position.line);
    const range = new vscode.Range(position, line.range.end);
    this.clearDecoration();
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: true,
      selection: new vscode.Range(position, position)
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.setDecorations(this.sourceDecoration, [range]);
    this.lastEditor = editor;
  }

  private clearDecoration(): void {
    this.lastEditor?.setDecorations(this.sourceDecoration, []);
    this.lastEditor = undefined;
  }

  dispose(): void {
    this.clearDecoration();
    this.sourceDecoration.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new LogcatSourceController(context);
  await controller.initialize();

  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(VIEW_ID, controller.provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('logcatSourceNavigator.focus', () => controller.focus()),
    vscode.commands.registerCommand('logcatSourceNavigator.browseIndexedLogs', () => controller.browseIndexedLogs()),
    vscode.commands.registerCommand('logcatSourceNavigator.indexSources', () => controller.indexSources()),
    vscode.commands.registerCommand('logcatSourceNavigator.loadLogcat', () => controller.loadLogcat()),
    vscode.commands.registerCommand('logcatSourceNavigator.clearSession', () => controller.clearSession()),
    vscode.commands.registerCommand('logcatSourceNavigator.nextMappedLog', () => controller.navigateMapped(1)),
    vscode.commands.registerCommand('logcatSourceNavigator.previousMappedLog', () => controller.navigateMapped(-1))
  );
}

export function deactivate(): void {}
