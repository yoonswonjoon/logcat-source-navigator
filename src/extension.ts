import path from 'node:path';
import * as vscode from 'vscode';
import { SourceIndexStore } from './core/indexStore';
import { availablePids, availableTids, parseLogcat } from './core/logcatParser';
import { filterMappedEvents, isAutomaticallyNavigable, LogFilter, matchLogcatEvents } from './core/matcher';
import { buildSourceIndex } from './core/sourceIndexer';
import { LogcatEvent, MappedLogEvent, MatchCandidate, SourceIndex } from './core/types';
import {
  LogcatSourceViewProvider,
  PanelFilters,
  PanelLogRow,
  PanelMessage,
  PanelState
} from './webview/logcatSourceView';

const VIEW_ID = 'logcatSourceNavigator.logView';
const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];

function normalizeIdFilter(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0))].sort(
    (left, right) => left - right
  );
}

class LogcatSourceController implements vscode.Disposable {
  private readonly store: SourceIndexStore;
  private readonly viewProvider: LogcatSourceViewProvider;
  private readonly sourceDecoration: vscode.TextEditorDecorationType;
  private sourceIndex?: SourceIndex;
  private logcatEvents: LogcatEvent[] = [];
  private mappedEvents: MappedLogEvent[] = [];
  private displayedEvents: MappedLogEvent[] = [];
  private selectedId?: string;
  private loadedLogcatName?: string;
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
              maxFileSizeBytes: maxFileSizeKb * 1024
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
      this.notice = `Indexed ${this.sourceIndex.sites.length} source logs from ${path.basename(root.fsPath)}.`;
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
        'Logcat files': ['log', 'logcat', 'txt', 'json'],
        'All files': ['*']
      },
      openLabel: 'Load logcat'
    });
    const file = selection?.[0];
    if (!file) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      this.loadLogcatText(path.basename(file.fsPath || file.path), Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to load logcat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  loadLogcatText(name: string, text: string): void {
    this.logcatEvents = parseLogcat(text);
    this.loadedLogcatName = name;
    this.selectedId = undefined;
    this.notice = this.logcatEvents.length
      ? `Loaded ${this.logcatEvents.length} parsed logcat events.`
      : 'No supported logcat lines were found. Try adb logcat -v threadtime.';
    this.refreshMappings();
  }

  clearSession(): void {
    this.logcatEvents = [];
    this.mappedEvents = [];
    this.displayedEvents = [];
    this.selectedId = undefined;
    this.loadedLogcatName = undefined;
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
      case 'loadLogcatText':
        this.loadLogcatText(message.name, message.text);
        return;
      case 'clearSession':
        this.clearSession();
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
      default:
        return;
    }
  }

  private refreshMappings(): void {
    const preMatchEvents = this.logcatEvents.filter((event) => {
      if (this.filters.pids !== undefined && (event.pid === undefined || !this.filters.pids.includes(event.pid))) return false;
      if (this.filters.tids !== undefined && (event.tid === undefined || !this.filters.tids.includes(event.tid))) return false;
      return this.filters.levels.includes(event.level);
    });
    this.mappedEvents = matchLogcatEvents(preMatchEvents, this.sourceIndex?.sites ?? []);
    this.displayedEvents = filterMappedEvents(this.mappedEvents, {
      query: this.filters.query,
      mappedOnly: this.filters.mappedOnly
    } satisfies LogFilter);
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
      level: mapped.event.level,
      tag: mapped.event.tag,
      message: mapped.event.message,
      status: mapped.status,
      candidates: mapped.candidates.map((candidate) => this.serializeCandidate(candidate))
    }));
    return {
      sourceRoots: this.sourceIndex?.roots ?? [],
      sourceSiteCount: this.sourceIndex?.sites.length ?? 0,
      indexCreatedAt: this.sourceIndex?.createdAt,
      loadedLogcatName: this.loadedLogcatName,
      totalEventCount: this.logcatEvents.length,
      displayedEventCount: rows.length,
      pids: availablePids(this.logcatEvents),
      tids: availableTids(this.logcatEvents),
      filters: this.filters,
      rows,
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

  private postState(): void {
    this.viewProvider.postState(this.getPanelState());
  }

  private async navigateToCandidate(candidate: MatchCandidate): Promise<void> {
    const position = new vscode.Position(Math.max(0, candidate.site.line - 1), candidate.site.column);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(candidate.site.filePath));
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
    vscode.commands.registerCommand('logcatSourceNavigator.indexSources', () => controller.indexSources()),
    vscode.commands.registerCommand('logcatSourceNavigator.loadLogcat', () => controller.loadLogcat()),
    vscode.commands.registerCommand('logcatSourceNavigator.clearSession', () => controller.clearSession()),
    vscode.commands.registerCommand('logcatSourceNavigator.nextMappedLog', () => controller.navigateMapped(1)),
    vscode.commands.registerCommand('logcatSourceNavigator.previousMappedLog', () => controller.navigateMapped(-1))
  );
}

export function deactivate(): void {}
