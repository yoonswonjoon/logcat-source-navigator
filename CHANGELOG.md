# Changelog

All notable changes to this project are documented in this file.

## 0.4.0 - 2026-08-04

- Added a selectable log-text format control: Auto, Android Studio JSON, Threadtime, Brief, and vendor `PID-TID` text.
- Added a workspace-persisted custom regex profile with named fields for level, tag, message, timestamp, PID/TID, and process/package.
- Reparse an already loaded log when its format changes, without choosing the file again.
- Recognize vendor rows such as `3616-3616 I Tag: message`, then pass their normalized fields to the existing source mapper.

## 0.3.0 - 2026-08-04

- Added **Browse Indexed Logs**, a searchable source-index browser that opens and highlights each logging call site without requiring a logcat file.
- Capped index-browser transfer to 500 rows while retaining a full match count, so large Android source trees remain responsive.
- Added an inclusive **Map input lines** range selector for loaded logcat files; large logs initially map only their newest 10,000 input lines.
- Limited the rendered logcat list to 2,000 filtered rows and prompts users to narrow the range when more remain.
- Optimized matching by grouping indexed sites by level and tag before mapping, avoiding a full source-index scan for every log event.

## 0.2.0 - 2026-08-04

- Added configurable Java/Kotlin logger facades, including `L.e(...)` and `L.w(...)` wrappers.
- Added custom tag/message argument positions for non-standard logger wrapper signatures.
- Made `.log` attachment reliable through VS Code's native file picker and stronger drag-and-drop fallbacks.
- Added full-date threadtime (`YYYY-MM-DD` and ISO `T`) text log parsing.

## 0.1.3 - 2026-08-03

- First public GitHub release.
- Added repository metadata, release installation instructions, and privacy guidance.
- Prevented logcat, dump, environment, and local Codex files from entering Git or VSIX packages.

## 0.1.2 - 2026-08-03

- Added support for Android Studio JSON logcat exports and `.logcat` files.
- Added multi-select PID and TID filters with All and None controls.
- Kept the selected log row visible while source navigation changes the selection.
- Added source-line mapping for Java, Kotlin, C, and C++ logging calls.
