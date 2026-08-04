import * as vscode from 'vscode';
import { MatchStatus } from '../core/types';

export interface PanelCandidate {
  id: string;
  relativePath: string;
  line: number;
  functionName?: string;
  reason: string;
}

export interface PanelLogRow {
  id: string;
  timestamp?: string;
  pid?: number;
  tid?: number;
  level: string;
  tag: string;
  message: string;
  status: MatchStatus;
  candidates: PanelCandidate[];
}

/** A compact, serializable view of one call site in the saved source index. */
export interface PanelIndexedLogRow {
  id: string;
  relativePath: string;
  line: number;
  functionName?: string;
  api: string;
  level: string;
  tag?: string;
  template: string;
  sourcePreview: string;
}

/**
 * The complete source index can contain tens of thousands of call sites.
 * Only a capped search result is sent to the webview at a time.
 */
export interface PanelIndexedLogs {
  visible: boolean;
  query: string;
  matchedCount: number;
  rows: PanelIndexedLogRow[];
  truncated: boolean;
}

/** The inclusive source-log line interval currently used for matching. */
export interface PanelLineRange {
  totalLineCount: number;
  startLine: number;
  endLine: number;
}

export interface PanelFilters {
  /** `undefined` means every ID is enabled; an empty array means none are enabled. */
  pids?: number[];
  tids?: number[];
  levels: string[];
  query: string;
  mappedOnly: boolean;
}

export interface PanelState {
  sourceRoots: string[];
  sourceSiteCount: number;
  indexCreatedAt?: string;
  loadedLogcatName?: string;
  totalEventCount: number;
  displayedEventCount: number;
  renderedEventCount: number;
  logRowsTruncated: boolean;
  lineRange: PanelLineRange;
  pids: number[];
  tids: number[];
  filters: PanelFilters;
  rows: PanelLogRow[];
  indexedLogs: PanelIndexedLogs;
  selectedId?: string;
  notice?: string;
}

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'indexSources' }
  | { type: 'loadLogcat' }
  | { type: 'loadLogcatUri'; uri: string }
  | { type: 'loadLogcatText'; name: string; text: string }
  | { type: 'loadLogcatError'; message: string }
  | { type: 'clearSession' }
  | { type: 'applyLineRange'; startLine: number; endLine: number }
  | { type: 'toggleIndexedLogs' }
  | { type: 'filterIndexedLogs'; query: string }
  | { type: 'filter'; filters: PanelFilters }
  | { type: 'select'; id: string }
  | { type: 'navigate'; delta: number }
  | { type: 'openCandidate'; eventId: string; candidateId: string }
  | { type: 'openIndexedLog'; id: string };

export class LogcatSourceViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly onMessage: (message: PanelMessage) => void) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: PanelMessage) => this.onMessage(message));
  }

  postState(state: PanelState): void {
    void this.view?.webview.postMessage({ type: 'state', state });
  }
}

function getHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Logcat Source</title>
  <style>
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    button, input, select { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; cursor: pointer; padding: 5px 9px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #app { display: grid; gap: 10px; padding: 10px; }
    .toolbar, .filters, .summary, .row, .candidate, .empty { display: flex; align-items: center; gap: 8px; }
    .toolbar { justify-content: space-between; flex-wrap: wrap; }
    .toolbar-actions, .filters { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .hint, .metadata, .source { color: var(--vscode-descriptionForeground); font-size: .9em; }
    .drop-zone { border: 1px dashed var(--vscode-panel-border); padding: 14px; text-align: center; color: var(--vscode-descriptionForeground); }
    .drop-zone.is-over { background: var(--vscode-list-hoverBackground); }
    .filter-group { display: flex; align-items: center; gap: 4px; }
    select, input[type="search"], input[type="number"] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
    input[type="search"] { min-width: 160px; }
    .id-filter { position: relative; }
    .id-filter > summary { list-style: none; cursor: pointer; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 7px; white-space: nowrap; }
    .id-filter > summary::-webkit-details-marker { display: none; }
    .id-filter > summary::after { content: ' ▾'; color: var(--vscode-descriptionForeground); }
    .id-filter[open] > summary::after { content: ' ▴'; }
    .id-filter-menu { position: absolute; z-index: 10; top: calc(100% + 3px); left: 0; width: min(300px, 76vw); color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); padding: 7px; }
    .id-filter-actions { display: flex; justify-content: flex-end; gap: 5px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
    .id-filter-actions button { padding: 3px 7px; }
    .id-filter-options { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 3px 8px; max-height: 190px; overflow: auto; padding-top: 7px; }
    .id-filter-option { display: flex; align-items: center; gap: 4px; min-width: 0; white-space: nowrap; }
    .levels { display: flex; gap: 3px; }
    .level { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); padding: 3px 6px; }
    .level.is-on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .summary { justify-content: space-between; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
    .line-range { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .line-range input[type="number"] { width: 8.5em; }
    .line-range button { padding: 4px 7px; }
    #log-list { outline: none; border: 1px solid var(--vscode-panel-border); max-height: 520px; overflow: auto; }
    .row { box-sizing: border-box; display: grid; grid-template-columns: minmax(135px, 1fr) minmax(72px, .5fr) 24px minmax(110px, .75fr) minmax(180px, 2.2fr) minmax(94px, .65fr); gap: 8px; width: 100%; text-align: left; color: var(--vscode-foreground); background: transparent; border-radius: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 8px; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.is-selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .row .message { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { font-size: .9em; white-space: nowrap; }
    .status.exact { color: var(--vscode-testing-iconPassed); }
    .status.pattern { color: var(--vscode-charts-blue); }
    .status.ambiguous { color: var(--vscode-editorWarning-foreground); }
    .status.low { color: var(--vscode-editorInfo-foreground); }
    .status.unmatched { color: var(--vscode-descriptionForeground); }
    #candidates { border: 1px solid var(--vscode-panel-border); padding: 8px; }
    .candidate { justify-content: space-between; padding: 6px 0; border-top: 1px solid var(--vscode-panel-border); }
    .candidate:first-of-type { border-top: 0; }
    .candidate-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { justify-content: center; min-height: 100px; color: var(--vscode-descriptionForeground); text-align: center; }
    #indexed-logs { display: grid; gap: 8px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
    .indexed-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .indexed-search { display: flex; gap: 6px; }
    .indexed-search input { box-sizing: border-box; width: 100%; }
    #indexed-log-list { outline: none; border: 1px solid var(--vscode-panel-border); max-height: 520px; overflow: auto; }
    .indexed-columns, .indexed-row { display: grid; grid-template-columns: 28px minmax(82px, .62fr) minmax(90px, .7fr) minmax(160px, 1.5fr) minmax(140px, 1.2fr) minmax(180px, 2.1fr); gap: 8px; }
    .indexed-columns { color: var(--vscode-descriptionForeground); font-size: .82em; padding: 0 8px; }
    .indexed-row { box-sizing: border-box; width: 100%; text-align: left; color: var(--vscode-foreground); background: transparent; border-radius: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 8px; }
    .indexed-row:hover { background: var(--vscode-list-hoverBackground); }
    .indexed-row .indexed-template, .indexed-row .indexed-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .indexed-level { font-weight: 700; }
    @media (max-width: 760px) {
      .row { grid-template-columns: minmax(120px, 1fr) 24px minmax(120px, 1fr); }
      .row .pid, .row .tag, .row .status { display: none; }
      .indexed-columns, .indexed-row { grid-template-columns: 28px minmax(80px, .8fr) minmax(120px, 1.4fr) minmax(150px, 1.8fr); }
      .indexed-columns .indexed-api, .indexed-columns .indexed-function, .indexed-row .indexed-api, .indexed-row .indexed-function { display: none; }
    }
  </style>
</head>
<body>
  <main id="app" aria-label="Logcat source navigator">
    <div class="toolbar">
      <div>
        <strong>LOGCAT SOURCE</strong>
        <span id="metadata" class="metadata"></span>
      </div>
      <div class="toolbar-actions">
        <button id="index-button" class="secondary" type="button">Index Source Folder</button>
        <button id="load-button" type="button">Attach Logcat / .log</button>
        <button id="browse-index-button" class="secondary" type="button">Browse Indexed Logs</button>
        <button id="clear-button" class="secondary" type="button">Clear</button>
      </div>
    </div>

    <div id="drop-zone" class="drop-zone" role="button" tabindex="0">
      Drop a .log, .logcat, .txt, or .json file here. If drop is blocked by VS Code, click Attach Logcat / .log.
    </div>

    <section id="filters" class="filters" aria-label="Log filters"></section>
    <section id="line-range" class="line-range" aria-label="Logcat line range">
      <span class="hint">Map input lines</span>
      <label>From <input id="line-range-start" type="number" min="1" inputmode="numeric" /></label>
      <label>To <input id="line-range-end" type="number" min="1" inputmode="numeric" /></label>
      <button id="apply-line-range" class="secondary" type="button">Map range</button>
      <button id="all-line-range" class="secondary" type="button">All lines</button>
      <span id="line-range-status" class="hint"></span>
    </section>
    <div id="summary" class="summary"></div>
    <div id="log-list" role="listbox" tabindex="0" aria-label="Mapped logcat rows"></div>
    <section id="candidates" hidden aria-label="Source candidates"></section>
    <section id="indexed-logs" hidden aria-label="Indexed logging calls">
      <div class="indexed-heading">
        <strong>INDEXED LOGGING CALLS</strong>
        <span id="indexed-log-summary" class="hint"></span>
      </div>
      <label class="indexed-search"><input id="indexed-log-query" type="search" placeholder="Search path, function, tag, or message" /></label>
      <div class="indexed-columns" aria-hidden="true"><span>LV</span><span class="indexed-api">API</span><span>TAG</span><span>FILE:LINE</span><span class="indexed-function">FUNCTION</span><span>MESSAGE TEMPLATE</span></div>
      <div id="indexed-log-list" role="listbox" tabindex="0" aria-label="Indexed logging calls"></div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
    let state = undefined;
    let queryTimer = undefined;
    let indexedQueryTimer = undefined;
    const openIdFilters = { pid: false, tid: false };

    const byId = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
    const statusText = (status) => ({ exact: '[+] Exact', pattern: '[~] Pattern', ambiguous: '[?] Candidates', low: '[~] Low', unmatched: 'Unmatched' }[status]);

    function post(type, extra = {}) { vscode.postMessage({ type, ...extra }); }
    function selectedIds(kind) {
      const allValues = kind === 'pid' ? state.pids : state.tids;
      const enabledValues = Array.from(document.querySelectorAll('input[data-id-filter="' + kind + '"]:checked'))
        .map((input) => Number(input.value))
        .filter((value) => Number.isInteger(value));
      return enabledValues.length === allValues.length ? undefined : enabledValues;
    }
    function currentFilters() {
      return {
        pids: selectedIds('pid'),
        tids: selectedIds('tid'),
        levels: Array.from(document.querySelectorAll('.level.is-on')).map((button) => button.dataset.level),
        query: byId('query-filter').value,
        mappedOnly: byId('mapped-only').checked
      };
    }
    function renderIdFilter(kind, label, values, selected) {
      const enabled = Array.isArray(selected) ? new Set(selected) : undefined;
      const enabledCount = enabled ? values.filter((value) => enabled.has(value)).length : values.length;
      const selectionLabel = enabled ? enabledCount + '/' + values.length : 'All (' + values.length + ')';
      const options = values.map((value) =>
        '<label class="id-filter-option"><input type="checkbox" data-id-filter="' + kind + '" value="' + value + '"' + (!enabled || enabled.has(value) ? ' checked' : '') + ' />' + value + '</label>'
      ).join('');
      return '<details class="id-filter" data-filter-group="' + kind + '"' + (openIdFilters[kind] ? ' open' : '') + '>' +
        '<summary>' + label + ': ' + selectionLabel + '</summary>' +
        '<div class="id-filter-menu">' +
          '<div class="id-filter-actions"><button class="secondary" type="button" data-id-action="all" data-id-kind="' + kind + '">All</button><button class="secondary" type="button" data-id-action="none" data-id-kind="' + kind + '">None</button></div>' +
          '<div class="id-filter-options">' + options + '</div>' +
        '</div>' +
      '</details>';
    }
    function rememberOpenIdFilter(element) {
      const details = element.closest('[data-filter-group]');
      if (details && details.dataset.filterGroup) openIdFilters[details.dataset.filterGroup] = details.open;
    }
    function renderFilters() {
      const filters = state.filters;
      byId('filters').innerHTML =
        renderIdFilter('pid', 'PID', state.pids, filters.pids) +
        renderIdFilter('tid', 'TID', state.tids, filters.tids) +
        '<span class="filter-group">Level <span class="levels">' + LEVELS.map((level) => '<button class="level ' + (filters.levels.includes(level) ? 'is-on' : '') + '" type="button" data-level="' + level + '" aria-pressed="' + filters.levels.includes(level) + '">' + level + '</button>').join('') + '</span></span>' +
        '<label class="filter-group"><input id="mapped-only" type="checkbox"' + (filters.mappedOnly ? ' checked' : '') + ' /> Mapped only</label>' +
        '<label class="filter-group"><input id="query-filter" type="search" value="' + escapeHtml(filters.query) + '" placeholder="Search tag, message, source" /></label>';
      byId('mapped-only').addEventListener('change', () => post('filter', { filters: currentFilters() }));
      document.querySelectorAll('[data-filter-group]').forEach((details) => details.addEventListener('toggle', () => {
        openIdFilters[details.dataset.filterGroup] = details.open;
      }));
      document.querySelectorAll('[data-id-filter]').forEach((input) => input.addEventListener('change', () => {
        rememberOpenIdFilter(input);
        post('filter', { filters: currentFilters() });
      }));
      document.querySelectorAll('[data-id-action]').forEach((button) => button.addEventListener('click', () => {
        rememberOpenIdFilter(button);
        const enabled = button.dataset.idAction === 'all';
        const kind = button.dataset.idKind;
        document.querySelectorAll('input[data-id-filter="' + kind + '"]').forEach((input) => { input.checked = enabled; });
        post('filter', { filters: currentFilters() });
      }));
      byId('query-filter').addEventListener('input', () => {
        clearTimeout(queryTimer);
        queryTimer = setTimeout(() => post('filter', { filters: currentFilters() }), 180);
      });
      document.querySelectorAll('.level').forEach((button) => button.addEventListener('click', () => {
        button.classList.toggle('is-on');
        button.setAttribute('aria-pressed', button.classList.contains('is-on'));
        post('filter', { filters: currentFilters() });
      }));
    }
    function renderLineRange() {
      const range = state.lineRange;
      const hasLogcat = range.totalLineCount > 0;
      const start = byId('line-range-start');
      const end = byId('line-range-end');
      const apply = byId('apply-line-range');
      const all = byId('all-line-range');
      start.disabled = !hasLogcat;
      end.disabled = !hasLogcat;
      apply.disabled = !hasLogcat;
      all.disabled = !hasLogcat;
      start.max = String(range.totalLineCount || 1);
      end.max = String(range.totalLineCount || 1);
      if (hasLogcat) {
        start.value = String(range.startLine);
        end.value = String(range.endLine);
        byId('line-range-status').textContent = range.startLine + '–' + range.endLine + ' / ' + range.totalLineCount + ' lines';
      } else {
        start.value = '';
        end.value = '';
        byId('line-range-status').textContent = 'Load a logcat to choose a range.';
      }
    }
    function applyLineRange() {
      const range = state.lineRange;
      if (!range.totalLineCount) return;
      post('applyLineRange', {
        startLine: Number(byId('line-range-start').value),
        endLine: Number(byId('line-range-end').value)
      });
    }
    function renderRows() {
      const list = byId('log-list');
      if (!state.rows.length) {
        list.innerHTML = '<div class="empty">Load a logcat file after indexing a source folder.</div>';
        return;
      }
      list.innerHTML = state.rows.map((row) =>
        '<button class="row ' + (row.id === state.selectedId ? 'is-selected' : '') + '" role="option" aria-selected="' + (row.id === state.selectedId) + '" type="button" data-id="' + row.id + '">' +
          '<span>' + escapeHtml(row.timestamp || '-') + '</span>' +
          '<span class="pid">' + escapeHtml((row.pid || '-') + '/' + (row.tid || '-')) + '</span>' +
          '<span>' + escapeHtml(row.level) + '</span>' +
          '<span class="tag">' + escapeHtml(row.tag) + '</span>' +
          '<span class="message">' + escapeHtml(row.message) + '</span>' +
          '<span class="status ' + row.status + '">' + statusText(row.status) + '</span>' +
        '</button>'
      ).join('');
      list.querySelectorAll('.row').forEach((row) => row.addEventListener('click', () => post('select', { id: row.dataset.id })));
    }
    function renderCandidates() {
      const panel = byId('candidates');
      const selected = state.rows.find((row) => row.id === state.selectedId);
      if (!selected || selected.candidates.length < 2) {
        panel.hidden = true;
        panel.innerHTML = '';
        return;
      }
      panel.hidden = false;
      panel.innerHTML = '<strong>Source candidates</strong>' + selected.candidates.map((candidate) =>
        '<div class="candidate"><span class="candidate-label">' + escapeHtml(candidate.relativePath + ':' + candidate.line + (candidate.functionName ? ' - ' + candidate.functionName : '') + ' (' + candidate.reason + ')') + '</span>' +
        '<button class="secondary" type="button" data-candidate="' + candidate.id + '">Open</button></div>'
      ).join('');
      panel.querySelectorAll('[data-candidate]').forEach((button) => button.addEventListener('click', () => post('openCandidate', { eventId: selected.id, candidateId: button.dataset.candidate })));
    }
    function renderIndexedLogs() {
      const browser = state.indexedLogs;
      const panel = byId('indexed-logs');
      panel.hidden = !browser.visible;
      if (!browser.visible) return;

      const query = byId('indexed-log-query');
      if (query.value !== browser.query) query.value = browser.query;
      const shownText = browser.truncated
        ? 'Showing first ' + browser.rows.length + ' of ' + browser.matchedCount + ' matches'
        : browser.rows.length + ' of ' + browser.matchedCount + ' matches';
      byId('indexed-log-summary').textContent = shownText + ' (' + state.sourceSiteCount + ' indexed)';

      const list = byId('indexed-log-list');
      if (!browser.rows.length) {
        list.innerHTML = '<div class="empty">' + (state.sourceSiteCount
          ? 'No indexed logging calls match this search.'
          : 'Index a source folder to browse its logging calls.') + '</div>';
        return;
      }
      list.innerHTML = browser.rows.map((row) =>
        '<button class="indexed-row" role="option" type="button" data-indexed-log-id="' + escapeHtml(row.id) + '" title="' + escapeHtml(row.sourcePreview) + '">' +
          '<span class="indexed-level">[' + escapeHtml(row.level) + ']</span>' +
          '<span class="indexed-api">' + escapeHtml(row.api) + '</span>' +
          '<span class="indexed-tag">' + escapeHtml(row.tag || '(no tag)') + '</span>' +
          '<span class="indexed-location">' + escapeHtml(row.relativePath + ':' + row.line) + '</span>' +
          '<span class="indexed-function">' + escapeHtml(row.functionName || '-') + '</span>' +
          '<span class="indexed-template">' + escapeHtml(row.template || row.sourcePreview) + '</span>' +
        '</button>'
      ).join('');
      list.querySelectorAll('[data-indexed-log-id]').forEach((row) => row.addEventListener('click', () => post('openIndexedLog', { id: row.dataset.indexedLogId })));
    }
    function render(nextState) {
      const active = document.activeElement;
      const restoreLogFocus = active === byId('log-list') || (active && active.classList && active.classList.contains('row'));
      const restoreIndexedQueryFocus = active === byId('indexed-log-query');
      const indexedQuerySelection = restoreIndexedQueryFocus
        ? { start: active.selectionStart, end: active.selectionEnd }
        : undefined;
      const previousSelectedId = state && state.selectedId;
      state = nextState;
      const browsingIndexedLogs = state.indexedLogs.visible;
      byId('metadata').textContent = state.sourceSiteCount + ' source logs / ' + state.totalEventCount + ' events';
      const visibleEventText = state.logRowsTruncated
        ? 'Showing first ' + state.renderedEventCount + ' of ' + state.displayedEventCount + ' visible events — narrow Map input lines or filters'
        : state.displayedEventCount + ' visible events';
      byId('summary').innerHTML = '<span>' + visibleEventText + '</span><span class="hint">' + escapeHtml(state.notice || (state.loadedLogcatName ? state.loadedLogcatName : 'No logcat loaded')) + '</span>';
      byId('browse-index-button').textContent = browsingIndexedLogs ? 'Back to Logcat' : 'Browse Indexed Logs';
      ['drop-zone', 'filters', 'line-range', 'summary', 'log-list', 'candidates'].forEach((id) => { byId(id).hidden = browsingIndexedLogs; });
      if (!browsingIndexedLogs) {
        renderFilters();
        renderLineRange();
        renderRows();
        renderCandidates();
        if (state.selectedId && state.selectedId !== previousSelectedId) {
          const selectedRow = byId('log-list').querySelector('.row.is-selected');
          selectedRow?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      renderIndexedLogs();
      if (restoreLogFocus) byId('log-list').focus();
      if (restoreIndexedQueryFocus) {
        const query = byId('indexed-log-query');
        query.focus();
        if (indexedQuerySelection) query.setSelectionRange(indexedQuerySelection.start, indexedQuerySelection.end);
      }
    }
    function reportDroppedLogcatError(message) {
      post('loadLogcatError', { message });
    }
    function loadFile(file) {
      if (!file) {
        reportDroppedLogcatError('No file was included in the drop.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reportDroppedLogcatError('The dropped file could not be read as text.');
          return;
        }
        post('loadLogcatText', { name: file.name || 'dropped-logcat.log', text: reader.result });
      };
      reader.onerror = () => reportDroppedLogcatError(reader.error ? reader.error.message : 'The dropped file could not be read.');
      reader.onabort = () => reportDroppedLogcatError('Reading the dropped file was cancelled.');
      try {
        reader.readAsText(file);
      } catch (error) {
        reportDroppedLogcatError(error instanceof Error ? error.message : String(error));
      }
    }
    function firstDroppedFile(dataTransfer) {
      if (!dataTransfer) return undefined;
      if (dataTransfer.files && dataTransfer.files.length) return dataTransfer.files[0];
      if (dataTransfer.items) {
        for (const item of dataTransfer.items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) return file;
          }
        }
      }
      return undefined;
    }
    function droppedUri(dataTransfer) {
      if (!dataTransfer) return undefined;
      const uriList = dataTransfer.getData('text/uri-list') || '';
      return uriList.split(/\\r?\\n/)
        .map((value) => value.trim())
        .find((value) => value && !value.startsWith('#') && /^(file|vscode-remote):/i.test(value));
    }
    function loadDroppedData(dataTransfer) {
      const file = firstDroppedFile(dataTransfer);
      if (file) {
        loadFile(file);
        return;
      }
      const uri = droppedUri(dataTransfer);
      if (uri) {
        post('loadLogcatUri', { uri });
        return;
      }
      reportDroppedLogcatError('VS Code did not provide an accessible file. Use Attach Logcat / .log to choose the file.');
    }
    byId('index-button').addEventListener('click', () => post('indexSources'));
    byId('load-button').addEventListener('click', () => post('loadLogcat'));
    byId('browse-index-button').addEventListener('click', () => post('toggleIndexedLogs'));
    byId('clear-button').addEventListener('click', () => post('clearSession'));
    byId('indexed-log-query').addEventListener('input', () => {
      clearTimeout(indexedQueryTimer);
      indexedQueryTimer = setTimeout(() => post('filterIndexedLogs', { query: byId('indexed-log-query').value }), 180);
    });
    byId('apply-line-range').addEventListener('click', () => applyLineRange());
    byId('all-line-range').addEventListener('click', () => {
      if (!state || !state.lineRange.totalLineCount) return;
      post('applyLineRange', { startLine: 1, endLine: state.lineRange.totalLineCount });
    });
    ['line-range-start', 'line-range-end'].forEach((id) => byId(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyLineRange();
      }
    }));
    const dropZone = byId('drop-zone');
    let dragDepth = 0;
    dropZone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth += 1;
      dropZone.classList.add('is-over');
    });
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('is-over');
    });
    dropZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropZone.classList.remove('is-over');
    });
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove('is-over');
      loadDroppedData(event.dataTransfer);
    });
    dropZone.addEventListener('dragend', () => {
      dragDepth = 0;
      dropZone.classList.remove('is-over');
    });
    dropZone.addEventListener('click', () => post('loadLogcat'));
    dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        post('loadLogcat');
      }
    });
    byId('log-list').addEventListener('keydown', (event) => {
      if (!state || !state.rows.length) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); post('navigate', { delta: event.key === 'ArrowRight' ? 1 : -1 }); return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const current = Math.max(0, state.rows.findIndex((row) => row.id === state.selectedId));
        const target = Math.max(0, Math.min(state.rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
        post('select', { id: state.rows[target].id });
      }
    });
    window.addEventListener('message', (event) => { if (event.data && event.data.type === 'state') render(event.data.state); });
    post('ready');
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}
