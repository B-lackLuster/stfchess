# Android 1.1 validation — 2026-10-23

Validated package: `stfchess.app`, version code 2, version name 1.1, ARM64, minimum API 24.

## Passed

- APK signature verification and ZIP alignment.
- ZIP entry integrity, DEX presence, packaged ARM64 Stockfish ELF architecture.
- All four packaged frontend files match the current source files.
- DEX inspection finds no references to the known incompatible `Process.isAlive` / `String.join` APIs.
- `TestCore` passes rule, score, PGN/FEN, annotation, locale and terminal-position regression checks.
- `TestAndroidServer` passes 13 HTTP integration checks: packaged home, CSS/JS, engine health, opening legal moves, user move, three variations, engine response, terminal status, PGN import, nested PGN variations, invalid FEN response, whole-game report and cancellation.

## Fixes found during validation

- Nested PGN variations were treated as moves and caused import failures. Comments and recursive variations are now excluded from the mainline; parsing stops at the first game result.
- A FEN without kings caused an internal array error. User positions are validated before chesslib generates moves and produce a readable client error.
- Engine liveness checks used `Process.isAlive`, unavailable on Android 7. They now use `exitValue` and handle the running-process exception.

## Scope

The Java checks run on a host JVM using the same Android backend classes and a host Stockfish executable. The HTTP tests load UI assets from the built APK. They do **not** execute the packaged ARM64 binary or Android WebView.

Installation, cold start, touch input, audio, downloads and lifecycle behavior on a real Android device or emulator remain unverified because no device was available.

APK SHA-256: `5e2fa96a1cb09dddf61bc5c317df97c25fceaec3bf6e45542f784875006ff52e`.
