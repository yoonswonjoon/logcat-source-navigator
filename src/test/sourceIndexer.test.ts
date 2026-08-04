import assert from 'node:assert/strict';
import test from 'node:test';
import { searchSourceLogSites } from '../core/indexSearch';
import { extractLogSitesFromSource } from '../core/sourceIndexer';

test('indexes Java Log calls with a local TAG constant and containing function', () => {
  const source = [
    'class Example {',
    '  private static final String TAG = "DemoService";',
    '  void connect(String reason) {',
    '    Log.d(TAG, "connect failed: " + reason);',
    '  }',
    '}'
  ].join('\n');

  const [site] = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');
  assert.equal(site.tag, 'DemoService');
  assert.equal(site.level, 'D');
  assert.equal(site.line, 4);
  assert.equal(site.functionName, 'connect');
  assert.equal(site.template.preview, 'connect failed: {value}');
});

test('ignores logger-shaped text in comments and string literals while parsing multiline calls', () => {
  const source = [
    'class Example {',
    '  // Log.d(TAG, "not a log");',
    '  String sample = "Slog.w(TAG, not a log)";',
    '  static final String TAG = "Demo";',
    '  void run(String reason) {',
    '    Slog.w(',
    '      TAG,',
    '      "failure: " + reason',
    '    );',
    '  }',
    '}'
  ].join('\n');

  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 6);
  assert.equal(sites[0].tag, 'Demo');
  assert.equal(sites[0].template.preview, 'failure: {value}');
});

test('indexes native ALOG calls with LOG_TAG and printf placeholders', () => {
  const source = [
    '#define LOG_TAG "NativeDemo"',
    'void report(int rc) {',
    '  ALOGE("rc=%d", rc);',
    '}'
  ].join('\n');

  const [site] = extractLogSitesFromSource(source, '/tmp/report.cpp', 'report.cpp');
  assert.equal(site.api, 'ALOG');
  assert.equal(site.tag, 'NativeDemo');
  assert.equal(site.level, 'E');
  assert.equal(site.template.preview, 'rc={value}');
});

test('understands Kotlin interpolation and String.format message templates', () => {
  const kotlin = [
    'class Example {',
    '  companion object { const val TAG = "KotlinDemo" }',
    '  fun report(uid: Int, retry: Int) {',
    '    Log.i(TAG, "uid=$uid failed")',
    '    Slog.w(TAG, String.format("retry %d", retry))',
    '  }',
    '}'
  ].join('\n');

  const sites = extractLogSitesFromSource(kotlin, '/tmp/Example.kt', 'Example.kt');
  assert.equal(sites.length, 2);
  assert.equal(sites[0].template.preview, 'uid={value} failed');
  assert.equal(sites[1].template.preview, 'retry {value}');
});

test('indexes configured L facade calls with common one- and two-argument wrapper signatures', () => {
  const source = [
    'class Example {',
    '  private static final String TAG = "FacadeDemo";',
    '  void report(String reason, Throwable error) {',
    '    L.v("verbose");',
    '    L.d(TAG, "debug: " + reason);',
    '    L.i("info");',
    '    L.w("retrying", error);',
    '    L.e(TAG, "failed: " + reason, error);',
    '    L.wtf("fatal");',
    '  }',
    '}'
  ].join('\n');

  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java', {
    customLoggers: [{ receiver: 'L' }]
  });

  assert.deepEqual(sites.map((site) => site.level), ['V', 'D', 'I', 'W', 'E', 'F']);
  assert.ok(sites.every((site) => site.api === 'Custom'));
  assert.equal(sites[1].tag, 'FacadeDemo');
  assert.equal(sites[3].tag, undefined);
  assert.equal(sites[4].template.preview, 'failed: {value}');
  assert.equal(sites[5].functionName, 'report');
});

test('supports explicit argument indices for non-standard custom logger wrapper signatures', () => {
  const source = [
    'class Example {',
    '  private static final String TAG = "AuditDemo";',
    '  void report(Throwable error, String reason) {',
    '    Audit.e(error, TAG, "audit failed: " + reason);',
    '  }',
    '}'
  ].join('\n');

  const [site] = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java', {
    customLoggers: [{ receiver: 'Audit', tagArgumentIndex: 1, messageArgumentIndex: 2 }]
  });

  assert.equal(site.api, 'Custom');
  assert.equal(site.tag, 'AuditDemo');
  assert.equal(site.level, 'E');
  assert.equal(site.template.preview, 'audit failed: {value}');
});

test('searches indexed log sites case-insensitively across paths, functions, tags, and messages', () => {
  const source = [
    'class Example {',
    '  static final String TAG = "AudioService";',
    '  void recover(String reason) { Slog.w(TAG, "restart failed: " + reason); }',
    '  void report() { Log.i(TAG, "started"); }',
    '}'
  ].join('\n');
  const sites = extractLogSitesFromSource(source, '/tmp/services/Audio.java', 'services/Audio.java');

  const result = searchSourceLogSites(sites, 'audioservice RESTART');

  assert.equal(result.total, 2);
  assert.equal(result.matched, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.rows[0].functionName, 'recover');
});

test('limits index-browser rows while retaining the complete match count', () => {
  const source = [
    'class Example {',
    '  static final String TAG = "Demo";',
    '  void first() { Log.d(TAG, "first"); }',
    '  void second() { Log.d(TAG, "second"); }',
    '  void third() { Log.d(TAG, "third"); }',
    '}'
  ].join('\n');
  const sites = extractLogSitesFromSource(source, '/tmp/Example.java', 'Example.java');

  const result = searchSourceLogSites(sites, undefined, 2);

  assert.equal(result.total, 3);
  assert.equal(result.matched, 3);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].functionName, 'first');
  assert.equal(result.rows[1].functionName, 'second');
  assert.equal(result.truncated, true);
});
