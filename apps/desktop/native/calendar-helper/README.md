# Native Calendar helper foundation

`main.swift` implements a single-request JSON protocol over stdin/stdout. Each
process reads at most 16 KiB and writes exactly one JSON object plus a newline.
It writes no diagnostic text to stderr and never includes an EventKit error
description in an error response.

| Command | Input fields | Success fields |
| --- | --- | --- |
| `status` | none | `authorization` |
| `request-full-access` | none | `authorization` |
| `list-events` | `start`, `end`, optional `limit` (1–200), optional `calendarIds` (1–20) | `events`, `truncated` |
| `create-event` | `title`, `start`, `end`, optional `calendarId` | `event` |

All success responses include `ok: true` and `command`. Errors have only
`ok: false` and a stable `code`. Dates must be ISO 8601 timestamps with a time
zone. Event objects contain `id`, `title`, `start`, `end`, `isAllDay`, and
`calendarId`. List ranges are limited to 31 days; created events to 7 days.
Titles are limited to 200 UTF-8 bytes. `status`, `list-events`, and
`create-event` never request Calendar permission; only the explicit
`request-full-access` command does. List and create require full access.

The supplied `Info.plist` is a template for packaging the executable as a
proper app bundle with a Calendar usage description. A bare command-line build
is only a compilation and synthetic validation target. Packaging, signing,
macOS TCC attribution, and whether the helper receives the intended permission
remain unproven until native integration and an explicit live test. In
particular, the helper must not be assumed to inherit Electron's permission.

Compile with Command Line Tools:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
  /Library/Developer/CommandLineTools/usr/bin/swiftc \
  -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
  -framework EventKit main.swift -o /tmp/jarvis-calendar-helper
```

Run synthetic protocol tests with `python3 test_protocol.py`. The test never
sends a command that queries Calendar or requests access.
