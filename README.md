# Logcat Source Navigator

A VS Code extension MVP for Android framework work. It indexes `Log.*`, `Slog.*`, and `ALOG*` calls in a selected source folder, then maps loaded logcat rows back to the source line that emitted them.

## What it does

- Indexes Java, Kotlin, C, and C++ source files without modifying the source tree.
- Parses Android Studio JSON logcat exports, `adb logcat -v threadtime`, and brief-format logs.
- Filters by one or more PID/TID values, level, and free-text query.
- Shows `exact`, `pattern`, `ambiguous`, and `unmatched` mapping states.
- Keeps ambiguous source locations as explicit candidates instead of guessing.
- Opens and highlights the source line as log rows are selected.

## Run locally

```powershell
npm install
npm run compile
```

Open this folder in VS Code and press `F5`. In the Extension Development Host, run **Logcat Source: Open Logcat Source** from the Command Palette (`Ctrl+Shift+P`) to reveal the bottom panel.

## Install

Download the latest `.vsix` from the [GitHub Releases page](https://github.com/yoonswonjoon/logcat-source-navigator/releases), then:

1. In VS Code, open **Extensions** and choose **Install from VSIX...** from the `...` menu.
2. Select the downloaded VSIX, then run **Developer: Reload Window**.
3. Run **Logcat Source: Open Logcat Source** from the Command Palette. This opens the bottom panel.
4. Select **Index Source Folder** and choose the Android module or framework source directory to inspect. The extension indexes log *call sites* rather than every source line.
5. Select **Load Logcat** (or drag a file onto the panel) and choose a supported input: Android Studio JSON export (`.logcat` / `.json`), `adb logcat -v threadtime`, or brief-format text.
6. Narrow the loaded rows with PID, TID, log level, or text search. Open the PID/TID control to select multiple values; **All** enables every value and **None** disables every value. PID and TID selections are combined with AND semantics.
7. Click an exact/pattern row to open and highlight its source line. When the row has multiple candidates, choose one under **Source candidates**; the extension does not guess.
8. Keep focus in the log list and use `Up`/`Down` to select rows or `Left`/`Right` to move between automatically mappable logs while the code editor follows. The list scrolls to keep the newly selected row visible.

Run **Index Source Folder** again after changing source logging calls. **Clear** removes only the loaded logcat; the cached source index remains.

If the panel was moved or hidden by VS Code, run **View: Reset View Locations**, then run **Logcat Source: Open Logcat Source** again.

## Local development

For local development, use the same flow after opening the bottom panel:

1. Select **Index Source Folder** and choose your Android module folder.
2. Select **Load Logcat File** and load an Android Studio JSON export or a `threadtime` logcat file.
3. Select rows or use the panel's arrow-key navigation to follow mapped source lines.

Use `adb logcat -v threadtime -d > logcat.txt` for the most useful input format.

## Privacy

Logcat parsing and source indexing run locally. The extension does not upload logcat files or source code. The cached source index is stored in VS Code's local extension storage and can include source paths, function names, log templates, and short source previews.

Never commit or share production logcat files, bugreports, or company source files. This repository intentionally ignores common log and dump extensions.

## Scope

This extension maps log output to source logging statements. It intentionally does not claim to reconstruct runtime caller stacks, Binder chains, or asynchronous execution paths.
