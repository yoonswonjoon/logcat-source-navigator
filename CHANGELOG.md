# Changelog

All notable changes to this project are documented in this file.

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
