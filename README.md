# Logcat Source Navigator

A VS Code extension MVP for Android framework work. It indexes `Log.*`, `Slog.*`, and `ALOG*` calls in a selected source folder, then maps loaded logcat rows back to the source line that emitted them.

## What it does

- Indexes Java, Kotlin, C, and C++ source files without modifying the source tree.
- Indexes configured Java/Kotlin logging facades such as `L.e(...)` and `L.w(...)`.
- Parses Android Studio JSON logcat exports, `adb logcat -v threadtime`, and brief-format logs.
- Selects built-in or custom text formats for vendor `.txt` / `.log` exports before mapping.
- Filters by one or more PID/TID values, level, and free-text query.
- Lets you browse the saved logging-call index directly, with search by path, function, tag, or message.
- Lets you choose the input-line range to map for large logcat files.
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
5. Choose **Log format** before selecting **Attach Logcat / .log** (or dropping a file). Supported built-ins are Auto, Android Studio JSON, Threadtime, Brief, and **Vendor PID-TID text**. The button uses VS Code's native file picker if the operating system blocks a drag-and-drop.
6. For a large file, set **Map input lines** → **From** and **To**, then select **Map range**. Only events whose log header falls in that inclusive range are matched. Files over 10,000 lines start with the newest 10,000 lines selected, so the panel stays responsive; choose **All lines** only when you intentionally want to map the entire file. If more than 2,000 filtered rows remain, the panel shows the first 2,000 and asks you to narrow the range or filters before navigating further.
7. Narrow the loaded rows with PID, TID, log level, or text search. Open the PID/TID control to select multiple values; **All** enables every value and **None** disables every value. PID and TID selections are combined with AND semantics.
8. Click an exact/pattern row to open and highlight its source line. When the row has multiple candidates, choose one under **Source candidates**; the extension does not guess.
9. Keep focus in the log list and use `Up`/`Down` to select rows or `Left`/`Right` to move between automatically mappable logs while the code editor follows. The list scrolls to keep the newly selected row visible.

Run **Index Source Folder** again after changing source logging calls. **Clear** removes only the loaded logcat; the cached source index remains.

## Browse indexed logging calls

Select **Browse Indexed Logs** in the panel (or run **Logcat Source: Browse Indexed Logging Calls** from the Command Palette) after indexing. This view does not need a loaded logcat: it shows the source call sites currently stored in the index. Search by source path, containing function, log tag, level/API, or message template, then select a row to open and highlight that source line.

To keep a framework-scale index responsive, the browser renders at most 500 matching call sites at once and tells you when the result is truncated. Add search text to narrow it further.

## Log text formats

Use **Auto detect** for normal Android Studio JSON, `threadtime`, brief logs, and common vendor rows such as:

```text
2026-08-04 10:00:00.000 3616-3616 I HMG-RotaryController: onAccessibilityEvent: EventType: TYPE_VIEW_FOCUSED
```

Choose **Vendor PID-TID text** to force that `PID-TID` form. A format change reparses the loaded file immediately, so you do not need to attach it again.

For another schema, choose **Custom regex profile**. Enter a JavaScript regular expression with named groups `level`, `tag`, and `message`; optional fields are `timestamp` or `date` + `time`, `pid`, `tid`, `process`, and `package`. Select **Save & Apply Custom Format** to retain it for the current VS Code workspace.

```regex
^(?<timestamp>\S+\s+\S+)\s+(?<pid>\d+)-(?<tid>\d+)\s+(?<level>[VDIWEF])\s+(?<tag>[^:]+):\s*(?<message>.*)$
```

The selected parser normalizes these fields before source matching. Consequently, an exact level/tag/template match works the same way for a vendor `.txt` file as for standard logcat.

If the panel was moved or hidden by VS Code, run **View: Reset View Locations**, then run **Logcat Source: Open Logcat Source** again.

## Custom logger facades

Add your project's wrapper in VS Code Settings JSON, then run **Index Source Folder** again.

```json
{
  "logcatSourceNavigator.customLoggers": [
    { "receiver": "L" }
  ]
}
```

The simple form recognizes `L.v/d/i/w/e/wtf(message)`, `L.e(message, throwable)`, and `L.e(TAG, message[, throwable])`. For an uncommon method signature, specify the zero-based tag and message argument positions:

```json
{
  "logcatSourceNavigator.customLoggers": [
    {
      "receiver": "Audit",
      "tagArgumentIndex": 1,
      "messageArgumentIndex": 2
    }
  ]
}
```

For example, this indexes `Audit.e(error, TAG, "message")`.

## Local development

For local development, use the same flow after opening the bottom panel:

1. Select **Index Source Folder** and choose your Android module folder.
2. Select **Attach Logcat / .log** and load an Android Studio JSON export, `.log` export, or `threadtime` logcat file.
3. Select rows or use the panel's arrow-key navigation to follow mapped source lines.

Use `adb logcat -v threadtime -d > logcat.txt` for the most useful input format.

## Privacy

Logcat parsing and source indexing run locally. The extension does not upload logcat files or source code. The cached source index is stored in VS Code's local extension storage and can include source paths, function names, log templates, and short source previews.

Never commit or share production logcat files, bugreports, or company source files. This repository intentionally ignores common log and dump extensions.

## Scope

This extension maps log output to source logging statements. It intentionally does not claim to reconstruct runtime caller stacks, Binder chains, or asynchronous execution paths.
