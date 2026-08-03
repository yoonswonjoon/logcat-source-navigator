import assert from 'node:assert/strict';
import test from 'node:test';
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
