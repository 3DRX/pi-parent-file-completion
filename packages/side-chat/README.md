# @3drx/pi-side-chat

A Pi extension that adds ephemeral side chats in a right-side overlay panel.

Open a side chat from the main Pi editor:

```text
/side
/side why is this failing?
```

The extension creates a real Pi branched session from the current conversation, opens it inside a side panel, and deletes that temporary side session when the panel is closed or merged.

## Behavior

- `/side` opens a right-side overlay panel.
- `/side <prompt>` opens the panel and immediately sends `<prompt>` to the side agent.
- The side session is forked from the current active branch using Pi's session tree APIs.
- The side agent receives additional system instructions that bias it toward read-only exploration.
- The side chat is ephemeral: its temporary session file is deleted on close/merge by default.
- Merge is only allowed when the main session has not changed since the side chat opened.

## Local side-chat commands

These commands are typed inside the side-chat panel, not in Pi's main editor:

```text
/help
/merge
/close
/close!
/abort
```

| Command | Meaning |
|---|---|
| `/help` | Show local side-chat commands. |
| `/merge` | Append the side-chat transcript to the main session, then close. |
| `/close` | Close and delete the side-chat session. |
| `/close!` | Force close after side effects were detected. |
| `/abort` | Abort the currently running side response. |

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
    "width": "30%",
    "maxHeight": "95%",
    "margin": 1,
    "maxTranscriptLines": 120
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
