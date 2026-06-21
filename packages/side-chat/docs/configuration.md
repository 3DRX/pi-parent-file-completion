# Side chat file-based configuration

`@3drx/pi-side-chat` can read optional JSON configuration from global and project-local files.

## Config file locations

Global config:

```text
~/.pi/agent/pi-extensions-lab/side-chat.json
```

Project-local config:

```text
<project>/.pi/pi-extensions-lab/side-chat.json
```

Project-local config is only read when the project is trusted by Pi. Project values override global values.

## Default population and partial config

The extension merges user config with defaults. You may write only the fields you want to override.

When `/side` loads configuration:

- If the global config file is missing, it is created with all default values.
- If the global config file contains only a subset of fields, it is rewritten as the full normalized config after applying your overrides.
- Project-local config files are not created automatically, but if a trusted project already has one, it is also rewritten as a full normalized effective config.

This keeps the configuration explicit while still allowing users to start with small partial JSON snippets.

## Default config

```json
{
  "panel": {
    "width": "30%",
    "height": "80%",
    "minHeight": 18,
    "maxHeight": "95%",
    "margin": 1,
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

## Reference

### `panel.width`

Type: number or percentage string  
Default: `"30%"`

Width of the right-side overlay panel.

Examples:

```json
{ "panel": { "width": "30%" } }
```

```json
{ "panel": { "width": 72 } }
```

### `panel.height`

Type: number or percentage string  
Default: `"80%"`

Target rendered panel height. Unlike `maxHeight`, this controls how tall the panel tries to be.

### `panel.minHeight`

Type: positive integer  
Default: `18`

Minimum rendered panel height.

### `panel.maxHeight`

Type: number or percentage string  
Default: `"95%"`

Maximum overlay height.

### `panel.margin`

Type: non-negative integer  
Default: `1`

Overlay margin, in terminal cells.

### `panel.maxTranscriptLines`

Type: positive integer  
Default: `120`

Maximum rendered transcript lines in the side panel. The panel also has a bottom-sticky viewport, so long output shows the latest content by default. Older lines are hidden from the panel view, but they remain in the side session until it is closed or merged.

### `panel.maxInputLines`

Type: positive integer  
Default: `5`

Maximum number of wrapped input lines shown at the bottom of the panel.

### `session.deleteOnClose`

Type: boolean  
Default: `true`

Delete the temporary side-chat session file when the user closes the panel with `/close`.

### `session.deleteOnMerge`

Type: boolean  
Default: `true`

Delete the temporary side-chat session file after a successful `/merge`.

### `merge.requireParentUnchanged`

Type: boolean  
Default: `true`

Require the main session to be unchanged before merging.

The extension snapshots the main session file, leaf id, and entry count when `/side` opens. If any of those values differ at `/merge` time, merge is blocked.

## Example

```json
{
  "panel": {
    "width": "35%",
    "height": "80%",
    "minHeight": 18,
    "maxHeight": "90%",
    "margin": 1,
    "maxTranscriptLines": 80,
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

## Notes

- Unknown keys are ignored and removed when the file is normalized.
- Invalid values fall back to defaults when the file is normalized.
- Project-local config requires Pi project trust.
- Side chats are intended to be ephemeral; disabling deletion is mainly useful for debugging.
