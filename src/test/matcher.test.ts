import assert from 'node:assert/strict';
import test from 'node:test';
import { matchLogcatEvents } from '../core/matcher';
import { extractLogSitesFromSource } from '../core/sourceIndexer';
import { LogcatEvent } from '../core/types';

function event(message: string, tag = 'Demo', level: LogcatEvent['level'] = 'W'): LogcatEvent {
  return {
    id: `event-${message}`,
    inputStartLine: 1,
    inputEndLine: 1,
    level,
    tag,
    message,
    rawLines: [message]
  };
}

test('maps a dynamic source template to a unique runtime log', () => {
  const source = [
    'class Example {',
    '  static final String TAG = "Demo";',
    '  void run(String reason) { Slog.w(TAG, "connect failed: " + reason); }',
    '}'
  ].join('\n');
  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');
  const [mapped] = matchLogcatEvents([event('connect failed: timeout')], sites);
  assert.equal(mapped.status, 'pattern');
  assert.equal(mapped.candidates.length, 1);
  assert.equal(mapped.candidates[0].site.functionName, 'run');
});

test('preserves duplicate source locations as ambiguous candidates', () => {
  const source = [
    'class Example {',
    '  static final String TAG = "Demo";',
    '  void first() { Slog.w(TAG, "state changed"); }',
    '  void second() { Slog.w(TAG, "state changed"); }',
    '}'
  ].join('\n');
  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');
  const [mapped] = matchLogcatEvents([event('state changed')], sites);
  assert.equal(mapped.status, 'ambiguous');
  assert.equal(mapped.candidates.length, 2);
});

test('does not map a matching message when tag or level differ', () => {
  const source = [
    'class Example {',
    '  static final String TAG = "Demo";',
    '  void first() { Slog.w(TAG, "state changed"); }',
    '}'
  ].join('\n');
  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');
  assert.equal(matchLogcatEvents([event('state changed', 'Other')], sites)[0].status, 'unmatched');
  assert.equal(matchLogcatEvents([event('state changed', 'Demo', 'I')], sites)[0].status, 'unmatched');
});

test('keeps ordered exact-tag matches and falls back to unresolved tags only after they miss', () => {
  const source = [
    'class Example {',
    '  static final String TAG = "Demo";',
    '  void first() { Slog.w(TAG, "same value"); }',
    '  void anotherTag() { Slog.w("Other", "same value"); }',
    '  void second() { Slog.w(TAG, "same value"); }',
    '  void dynamic(String runtimeTag) { Slog.w(runtimeTag, "fallback value"); }',
    '  void wrongExactTag() { Slog.w(TAG, "not the fallback"); }',
    '}'
  ].join('\n');
  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');

  const [exact, fallback] = matchLogcatEvents(
    [event('same value'), event('fallback value')],
    sites
  );

  assert.deepEqual(
    exact.candidates.map((candidate) => candidate.site.functionName),
    ['first', 'second']
  );
  assert.equal(fallback.status, 'exact');
  assert.equal(fallback.candidates.length, 1);
  assert.equal(fallback.candidates[0].site.functionName, 'dynamic');
  assert.deepEqual(fallback.candidates[0].reason, ['unresolved source tag', 'same level', 'literal message']);
});
