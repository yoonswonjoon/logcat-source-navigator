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
