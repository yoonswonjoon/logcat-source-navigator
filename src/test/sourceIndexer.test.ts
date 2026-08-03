import assert from 'node:assert/strict';
import test from 'node:test';
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
