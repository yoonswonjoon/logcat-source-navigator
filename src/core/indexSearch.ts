import { SourceLogSite } from './types';

/**
 * The largest number of source locations sent to the index browser at once.
 * The full match count is still calculated so callers can tell users when
 * they should narrow their search.
 */
export const DEFAULT_INDEX_SEARCH_LIMIT = 500;

export interface IndexedLogSearchResult {
  /** Number of log sites in the complete source index. */
  total: number;
  /** Number of log sites matching the current query before the row limit. */
  matched: number;
  /** The first matching rows, kept in the original source-index order. */
  rows: SourceLogSite[];
  /** Whether additional matches were omitted from rows because of the limit. */
  truncated: boolean;
}

function normalizedTerms(query: string | undefined): string[] {
  if (typeof query !== 'string') return [];
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function searchableText(site: SourceLogSite): string {
  return [
    site.id,
    site.api,
    site.level,
    site.tag,
    site.relativePath,
    site.filePath,
    site.line,
    site.column,
    site.functionName,
    site.template?.preview,
    site.sourcePreview
  ]
    .map(text)
    .join(' ')
    .toLowerCase();
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_INDEX_SEARCH_LIMIT;
  return Math.max(0, Math.floor(limit));
}

/**
 * Searches indexed source-log call sites without changing their source order.
 * Whitespace-separated query terms may match different fields (for example,
 * `AudioService timeout` matches a tag and message template together).
 */
export function searchSourceLogSites(
  sites: readonly SourceLogSite[],
  query?: string,
  limit?: number
): IndexedLogSearchResult {
  const terms = normalizedTerms(query);
  const rowLimit = normalizedLimit(limit);
  const rows: SourceLogSite[] = [];
  let matched = 0;

  for (const site of sites) {
    const haystack = terms.length > 0 ? searchableText(site) : '';
    if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) continue;

    matched += 1;
    if (rows.length < rowLimit) rows.push(site);
  }

  return {
    total: sites.length,
    matched,
    rows,
    truncated: matched > rows.length
  };
}
