import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOG_MAPPING_LINE_LIMIT,
  countLogTextLines,
  defaultLogMappingRange,
  filterLogcatEventsByLineRange,
  normalizeLogLineRange
} from '../core/logRange';
import { availablePids, parseLogcat } from '../core/logcatParser';

test('parses threadtime and brief logcat formats and groups continuation lines', () => {
  const logcat = [
    '--------- beginning of main',
    '01-10 12:00:01.123  1048  1204 I DemoService: connect failed: timeout',
    'java.lang.IllegalStateException: sample',
    '    at example.Foo.run(Foo.java:12)',
    'W/NativeDemo(  99): rc=-12'
  ].join('\n');

  const events = parseLogcat(logcat);
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, '01-10 12:00:01.123');
  assert.equal(events[0].pid, 1048);
  assert.equal(events[0].tid, 1204);
  assert.equal(events[0].message, 'connect failed: timeout');
  assert.equal(events[0].rawLines.length, 3);
  assert.equal(events[1].tag, 'NativeDemo');
  assert.deepEqual(availablePids(events), [99, 1048]);
});

test('parses full-date threadtime lines from text .log exports', () => {
  const logcat = [
    '\uFEFF2026-08-03 22:13:50.123  22745  16864 W DemoService: connect failed: timeout',
    '2026-08-03T22:13:51.456  22745  16864 E DemoService: retry exhausted'
  ].join('\n');

  const events = parseLogcat(logcat);
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, '2026-08-03 22:13:50.123');
  assert.equal(events[0].pid, 22745);
  assert.equal(events[0].tid, 16864);
  assert.equal(events[1].timestamp, '2026-08-03 22:13:51.456');
  assert.equal(events[1].level, 'E');
  assert.equal(events[1].message, 'retry exhausted');
});

test('parses Android Studio JSON logcat exports', () => {
  const exported = JSON.stringify({
    metadata: { device: { physicalDevice: { model: 'SM-G986N' } } },
    logcatMessages: [
      {
        header: {
          logLevel: 'WARN',
          pid: 22745,
          tid: 16864,
          tag: 'DemoService',
          timestamp: { seconds: 1, nanos: 123_456_789 }
        },
        message: 'connect failed: timeout\njava.lang.IllegalStateException: sample'
      },
      {
        header: {
          logLevel: 'ASSERT',
          pid: 99,
          tid: 99,
          tag: 'NativeDemo',
          timestamp: { seconds: 2, nanos: 0 }
        },
        message: 'fatal state'
      }
    ]
  });

  const events = parseLogcat(exported);
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, '1970-01-01T00:00:01.123Z');
  assert.equal(events[0].level, 'W');
  assert.equal(events[0].message, 'connect failed: timeout');
  assert.deepEqual(events[0].rawLines, ['connect failed: timeout', 'java.lang.IllegalStateException: sample']);
  assert.equal(events[1].level, 'F');
  assert.deepEqual(availablePids(events), [99, 22745]);
});

test('counts physical text lines while ignoring a final newline', () => {
  assert.equal(countLogTextLines(''), 0);
  assert.equal(countLogTextLines('one'), 1);
  assert.equal(countLogTextLines('one\n'), 1);
  assert.equal(countLogTextLines('one\r\ntwo\rthree'), 2);
  assert.equal(countLogTextLines('\n\n'), 2);
});

test('normalizes requested log line ranges to a one-based inclusive selection', () => {
  assert.deepEqual(normalizeLogLineRange(100, { startLine: ' 9 ', endLine: 12.8 }), {
    startLine: 9,
    endLine: 12
  });
  assert.deepEqual(normalizeLogLineRange(100, { startLine: -3, endLine: 4 }), {
    startLine: 1,
    endLine: 4
  });
  assert.deepEqual(normalizeLogLineRange(100, { startLine: 120, endLine: 8 }), {
    startLine: 8,
    endLine: 100
  });
  assert.deepEqual(normalizeLogLineRange(12, { startLine: 'not a line', endLine: '' }), {
    startLine: 1,
    endLine: 12
  });
  assert.equal(normalizeLogLineRange(0, { startLine: 1, endLine: 1 }), undefined);
});

test('uses the newest 10,000 lines as the safe default mapping range', () => {
  assert.equal(DEFAULT_LOG_MAPPING_LINE_LIMIT, 10_000);
  assert.deepEqual(defaultLogMappingRange(87), { startLine: 1, endLine: 87 });
  assert.deepEqual(defaultLogMappingRange(15_020), { startLine: 5_021, endLine: 15_020 });
  assert.deepEqual(defaultLogMappingRange(15_020, 200), { startLine: 14_821, endLine: 15_020 });
  assert.equal(defaultLogMappingRange(0), undefined);
});

test('filters parsed logcat events using their header input line', () => {
  const events = parseLogcat([
    '01-10 12:00:01.123  1048  1204 I DemoService: first',
    'stack trace continuation',
    '01-10 12:00:02.123  1048  1204 W DemoService: second',
    '01-10 12:00:03.123  1048  1204 E DemoService: third'
  ].join('\n'));

  const selected = filterLogcatEventsByLineRange(events, { startLine: 2, endLine: 3 });
  assert.deepEqual(selected.map((event) => event.message), ['second']);
  assert.deepEqual(selected.map((event) => event.inputStartLine), [3]);
  assert.deepEqual(filterLogcatEventsByLineRange(events, undefined), []);
});
