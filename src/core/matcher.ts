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

interface MatcherSiteIndex {
  /** Sites with a statically resolved source tag, grouped by level and tag. */
  readonly resolvedTagsByLevel: Map<LogLevel, Map<string, SourceLogSite[]>>;
  /** Sites whose source tag cannot be resolved statically, grouped by level. */
  readonly unresolvedTagsByLevel: Map<LogLevel, SourceLogSite[]>;
}

/**
 * Builds the lookup tables once per logcat mapping operation.
 *
 * Each bucket appends sites in the input order. This matters because candidates
 * with equal scores keep their source-index order after the stable score sort.
 */
function buildMatcherSiteIndex(sites: readonly SourceLogSite[]): MatcherSiteIndex {
  const resolvedTagsByLevel = new Map<LogLevel, Map<string, SourceLogSite[]>>();
  const unresolvedTagsByLevel = new Map<LogLevel, SourceLogSite[]>();

  for (const site of sites) {
    if (site.tag === undefined) {
      const unresolved = unresolvedTagsByLevel.get(site.level);
      if (unresolved) {
        unresolved.push(site);
      } else {
        unresolvedTagsByLevel.set(site.level, [site]);
      }
      continue;
    }

    let tagsForLevel = resolvedTagsByLevel.get(site.level);
    if (!tagsForLevel) {
      tagsForLevel = new Map<string, SourceLogSite[]>();
      resolvedTagsByLevel.set(site.level, tagsForLevel);
    }

    const resolved = tagsForLevel.get(site.tag);
    if (resolved) {
      resolved.push(site);
    } else {
      tagsForLevel.set(site.tag, [site]);
    }
  }

  return { resolvedTagsByLevel, unresolvedTagsByLevel };
}

function matchingCandidates(
  event: LogcatEvent,
  sites: readonly SourceLogSite[],
  tagIsExact: boolean
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const site of sites) {
    const candidate = siteMatchesEvent(site, event, tagIsExact);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function candidatesForEvent(event: LogcatEvent, siteIndex: MatcherSiteIndex): MatchCandidate[] {
  const exactTag = matchingCandidates(
    event,
    siteIndex.resolvedTagsByLevel.get(event.level)?.get(event.tag) ?? [],
    true
  );

  if (exactTag.length > 0) {
    return exactTag;
  }

  return matchingCandidates(event, siteIndex.unresolvedTagsByLevel.get(event.level) ?? [], false);
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
  const siteIndex = buildMatcherSiteIndex(sites);
  return events.map((event) => {
    const candidates = candidatesForEvent(event, siteIndex).sort((left, right) => right.score - left.score);
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
