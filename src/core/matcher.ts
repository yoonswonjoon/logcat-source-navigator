import { normalizeMessage, templateMatches } from './normalization';
import { LogLevel, LogcatEvent, MappedLogEvent, MatchCandidate, MatchStatus, SourceLogSite } from './types';

export interface LogFilter {
  pid?: number;
  tid?: number;
  levels?: LogLevel[];
  query?: string;
  mappedOnly?: boolean;
}

function siteMatchesEvent(site: SourceLogSite, event: LogcatEvent, tagIsExact: boolean): MatchCandidate | undefined {
  if (site.level !== event.level || site.template.staticChars < 4) {
    return undefined;
  }
  if (!templateMatches(site.template, event.message)) {
    return undefined;
  }

  const eventMessage = normalizeMessage(event.message);
  const templateMessage = normalizeMessage(site.template.preview);
  const literalExact = site.template.isLiteralOnly && templateMessage === eventMessage;
  const score =
    (tagIsExact ? 100 : 12) +
    20 +
    Math.min(site.template.staticChars, 60) +
    (literalExact ? 40 : 0);
  const reason = [
    tagIsExact ? 'exact tag' : 'unresolved source tag',
    'same level',
    literalExact ? 'literal message' : 'message template'
  ];

  return { site, score, reason };
}

function candidatesForEvent(event: LogcatEvent, sites: SourceLogSite[]): MatchCandidate[] {
  const sameLevel = sites.filter((site) => site.level === event.level);
  const exactTag = sameLevel
    .filter((site) => site.tag === event.tag)
    .map((site) => siteMatchesEvent(site, event, true))
    .filter((candidate): candidate is MatchCandidate => candidate !== undefined);

  if (exactTag.length > 0) {
    return exactTag;
  }

  return sameLevel
    .filter((site) => site.tag === undefined)
    .map((site) => siteMatchesEvent(site, event, false))
    .filter((candidate): candidate is MatchCandidate => candidate !== undefined);
}

function statusFor(candidates: MatchCandidate[]): MatchStatus {
  if (candidates.length === 0) return 'unmatched';
  const [best, second] = candidates;
  if (second && best.score - second.score < 15) return 'ambiguous';
  if (best.score < 75) return 'low';
  if (best.site.template.isLiteralOnly) return 'exact';
  return 'pattern';
}

export function matchLogcatEvents(events: LogcatEvent[], sites: SourceLogSite[]): MappedLogEvent[] {
  return events.map((event) => {
    const candidates = candidatesForEvent(event, sites).sort((left, right) => right.score - left.score);
    return {
      event,
      status: statusFor(candidates),
      candidates: candidates.slice(0, 12)
    };
  });
}

export function filterMappedEvents(events: MappedLogEvent[], filter: LogFilter): MappedLogEvent[] {
  const query = filter.query?.trim().toLowerCase();
  return events.filter((mapped) => {
    const { event } = mapped;
    if (filter.pid !== undefined && event.pid !== filter.pid) return false;
    if (filter.tid !== undefined && event.tid !== filter.tid) return false;
    if (filter.levels && !filter.levels.includes(event.level)) return false;
    if (filter.mappedOnly && mapped.status === 'unmatched') return false;
    if (query) {
      const candidateText = mapped.candidates
        .map((candidate) => `${candidate.site.relativePath} ${candidate.site.functionName ?? ''}`)
        .join(' ');
      const searchable = `${event.tag} ${event.message} ${candidateText}`.toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  });
}

export function isAutomaticallyNavigable(mapped: MappedLogEvent): boolean {
  return (mapped.status === 'exact' || mapped.status === 'pattern' || mapped.status === 'low') && mapped.candidates.length === 1;
}
