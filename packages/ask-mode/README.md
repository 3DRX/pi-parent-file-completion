# @3drx/pi-ask-mode

A Pi extension that adds an opt-in **ask mode** (working name) where the agent is encouraged to ask the user structured questions instead of guessing.

When enabled, the agent gets an `ask_user_choice` tool. The tool shows a terminal UI with:

- one question at a time
- any number of concrete options
- detailed descriptions for each option
- an automatically appended custom-response option

For example, if the agent provides two concrete technical options, the UI shows:

```text
A. Choice A
B. Choice B
C. Type your own answer.
```

If the agent provides six concrete options, the UI shows all six plus a seventh custom-response option. The schema does not impose a maximum number of options.

## Commands

```text
/askmode          # toggle ask mode
/askmode on       # enable ask mode
/askmode off      # disable ask mode
/askmode status   # show current state
```

Ask mode is intentionally enabled only by the slash command. When disabled, the extension removes `ask_user_choice` from the active tool list.

## Agent behavior

While ask mode is active, the extension injects per-turn instructions that tell the agent to:

- be more willing to ask when user preference, constraints, environment, or a technical tradeoff matters
- ask exactly one question per `ask_user_choice` call
- never call `ask_user_choice` more than once in the same assistant turn
- wait for the current answer before deciding whether to ask a follow-up question
- include every meaningful concrete option, with detailed explanations
- not include its own "Other" option, because the UI appends a custom-response option automatically

The extension also enforces the one-question-at-a-time rule by blocking a second `ask_user_choice` call in the same assistant turn.

## Local development

From the monorepo root:

```bash
pnpm install
pnpm --filter @3drx/pi-ask-mode typecheck
pi -e ./packages/ask-mode/src/index.ts
```

Or load the whole monorepo Pi package:

```bash
pi -e /absolute/path/to/pi-extensions-lab
```

Then enable it in chat:

```text
/askmode on
```

## Notes on Pi API coverage

Pi's extension API is sufficient for this feature:

1. `pi.registerTool()` exposes `ask_user_choice` to the agent.
2. `before_agent_start` injects the opt-in prompt that biases the agent toward asking.
3. `ctx.ui.custom()` implements the terminal choice UI.
4. `pi.registerCommand()` provides the `/askmode` toggle.
5. `tool_call` interception enforces one question per assistant turn.
