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
  pids: number[];
  tids: number[];
  filters: PanelFilters;
  rows: PanelLogRow[];
  selectedId?: string;
  notice?: string;
}

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'indexSources' }
  | { type: 'loadLogcat' }
  | { type: 'loadLogcatText'; name: string; text: string }
  | { type: 'clearSession' }
  | { type: 'filter'; filters: PanelFilters }
  | { type: 'select'; id: string }
  | { type: 'navigate'; delta: number }
  | { type: 'openCandidate'; eventId: string; candidateId: string };

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
    select, input[type="search"] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
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
    #file-input { display: none; }
    @media (max-width: 760px) {
      .row { grid-template-columns: minmax(120px, 1fr) 24px minmax(120px, 1fr); }
      .row .pid, .row .tag, .row .status { display: none; }
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
        <button id="load-button" type="button">Load Logcat</button>
        <button id="clear-button" class="secondary" type="button">Clear</button>
      </div>
    </div>

    <input id="file-input" type="file" accept=".log,.logcat,.txt,.json,text/plain,application/json" />
    <div id="drop-zone" class="drop-zone" role="button" tabindex="0">
      Drop a logcat file here, or choose Load Logcat. Supports adb text logs and Android Studio JSON exports.
    </div>

    <section id="filters" class="filters" aria-label="Log filters"></section>
    <div id="summary" class="summary"></div>
    <div id="log-list" role="listbox" tabindex="0" aria-label="Mapped logcat rows"></div>
    <section id="candidates" hidden aria-label="Source candidates"></section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
    let state = undefined;
    let queryTimer = undefined;
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
    function render(nextState) {
      const active = document.activeElement;
      const restoreLogFocus = active === byId('log-list') || (active && active.classList && active.classList.contains('row'));
      const previousSelectedId = state && state.selectedId;
      state = nextState;
      byId('metadata').textContent = state.sourceSiteCount + ' source logs / ' + state.totalEventCount + ' events';
      byId('summary').innerHTML = '<span>' + state.displayedEventCount + ' visible events</span><span class="hint">' + escapeHtml(state.notice || (state.loadedLogcatName ? state.loadedLogcatName : 'No logcat loaded')) + '</span>';
      renderFilters();
      renderRows();
      renderCandidates();
      if (state.selectedId && state.selectedId !== previousSelectedId) {
        const selectedRow = byId('log-list').querySelector('.row.is-selected');
        selectedRow?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (restoreLogFocus) byId('log-list').focus();
    }
    function loadFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => post('loadLogcatText', { name: file.name, text: String(reader.result || '') });
      reader.readAsText(file);
    }
    byId('index-button').addEventListener('click', () => post('indexSources'));
    byId('load-button').addEventListener('click', () => byId('file-input').click());
    byId('clear-button').addEventListener('click', () => post('clearSession'));
    byId('file-input').addEventListener('change', (event) => loadFile(event.target.files && event.target.files[0]));
    const dropZone = byId('drop-zone');
    dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('is-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
    dropZone.addEventListener('drop', (event) => { event.preventDefault(); dropZone.classList.remove('is-over'); loadFile(event.dataTransfer.files && event.dataTransfer.files[0]); });
    dropZone.addEventListener('click', () => byId('file-input').click());
    dropZone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') byId('file-input').click(); });
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
