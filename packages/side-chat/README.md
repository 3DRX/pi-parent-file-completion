# @3drx/pi-side-chat

A Pi extension that adds ephemeral side chats in a right-side overlay panel.

Open a side chat from the main Pi editor:

```text
/side
/side why is this failing?
```

The extension creates a real Pi branched session from the current conversation, opens it inside a side panel, and deletes that temporary side session when the panel is closed or merged.

## Behavior

- `/side` opens a top-aligned panel flush with the right edge of the terminal, or restores a hidden side panel.
- `/side <prompt>` opens/restores the panel and immediately sends `<prompt>` to the side agent.
- The side session is forked from the current active branch using Pi's session tree APIs.
- The side agent receives additional system instructions that bias it toward read-only exploration.
- Assistant and user messages render as Markdown with syntax-highlighted code blocks.
- The input area uses Pi's native editor component, so paste, dictation-style insertion, cursor movement, and multiline editing work like Pi's main editor.
- Up/down arrows browse previous/following side-chat inputs, like Pi's main editor.
- Ctrl+Up/Ctrl+Down and mouse-wheel scrolling over the panel control transcript scrollback; Ctrl+Home/Ctrl+End jump to the top/bottom, and `/bottom` jumps back to the latest content.
- Escape hides the side panel without closing or deleting the temporary side session; run `/side` in the main editor to restore it.
- The side chat is ephemeral: its temporary session file is deleted on explicit `/close` or `/merge` by default.
- Merge is only allowed when the main session has not changed since the side chat opened.

## Local side-chat commands

These commands are typed inside the side-chat panel, not in Pi's main editor:

```text
/help
/merge
/close
/close!
/abort
/bottom
```

| Command | Meaning |
|---|---|
| `/help` | Show local side-chat commands. |
| `/merge` | Append the side-chat transcript to the main session, then close. |
| `/close` | Explicitly close and delete the side-chat session. |
| `/close!` | Force explicit close after side effects were detected. |
| `/abort` | Abort the currently running side response. |
| `/bottom` | Jump back to the latest transcript content. |

## Merge safety

When a side chat opens, the extension snapshots the main session:

- session file
- current leaf id
- entry count

`/merge` is blocked if any of those values changed. This prevents merging stale side-chat context into a main thread that moved on.

## File-based configuration

See [docs/configuration.md](docs/configuration.md).

Default configuration:

```json
{
  "panel": {
    "width": "50%",
    "height": "100%",
    "minHeight": 18,
    "maxHeight": "100%",
    "margin": 0,
    "maxTranscriptLines": 120,
    "maxInputLines": 5
  },
  "session": {
    "deleteOnClose": true,
    "deleteOnMerge": true
  },
  "merge": {
    "requireParentUnchanged": true
  }
}
```

## Local development

From the monorepo root:

```bash
pnpm install
pnpm --filter @3drx/pi-side-chat typecheck
pi -e ./packages/side-chat/src/index.ts
```

Or load the whole monorepo Pi package:

```bash
pi -e /absolute/path/to/pi-extensions-lab
```
