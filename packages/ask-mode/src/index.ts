import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MODE_NAME = "ask-mode";
const TOOL_NAME = "ask_user_choice";

interface ChoiceOption {
	value?: string;
	label: string;
	description?: string;
}

type RenderChoiceOption = ChoiceOption & { isCustom?: boolean };

interface ChoiceAnswer {
	value: string;
	label: string;
	letter: string;
	wasCustom: boolean;
	index?: number;
}

interface ChoiceDetails {
	question: string;
	context?: string;
	options: ChoiceOption[];
	answer: ChoiceAnswer | null;
	cancelled: boolean;
}

const ChoiceOptionSchema = Type.Object({
	value: Type.Optional(
		Type.String({
			description: "Stable machine-readable value for this option. Defaults to the label.",
		}),
	),
	label: Type.String({ description: "Short display label for the option." }),
	description: Type.Optional(
		Type.String({
			description: "Detailed explanation, tradeoffs, or when the user should pick this option.",
		}),
	),
});

const AskUserChoiceParams = Type.Object({
	question: Type.String({ description: "A single, specific question to ask the user." }),
	context: Type.Optional(
		Type.String({
			description: "Optional short context explaining why the choice matters.",
		}),
	),
	options: Type.Array(ChoiceOptionSchema, {
		description:
			"All concrete options the user should choose from. Include every meaningful option; do not add an Other/custom option because the UI appends one automatically.",
	}),
	customOptionLabel: Type.Optional(
		Type.String({
			description: "Optional label for the automatically appended custom response option.",
		}),
	),
});

function optionLetter(index: number): string {
	let n = index + 1;
	let result = "";
	while (n > 0) {
		n -= 1;
		result = String.fromCharCode(65 + (n % 26)) + result;
		n = Math.floor(n / 26);
	}
	return result;
}

function normalizeArgs(args: string): "on" | "off" | "toggle" | "status" {
	const normalized = args.trim().toLowerCase();
	if (["on", "enable", "enabled", "start", "open"].includes(normalized)) return "on";
	if (["off", "disable", "disabled", "stop", "close"].includes(normalized)) return "off";
	if (["status", "state"].includes(normalized)) return "status";
	return "toggle";
}

function getModeState(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== MODE_NAME) continue;
		const data = entry.data as { enabled?: unknown } | undefined;
		enabled = data?.enabled === true;
	}
	return enabled;
}

class AskChoiceComponent implements Focusable {
	private selectedIndex = 0;
	private inputMode = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly editor: Editor;
	private _focused = false;

	constructor(
		private readonly tui: ConstructorParameters<typeof Editor>[0],
		private readonly theme: Theme,
		private readonly question: string,
		private readonly context: string | undefined,
		private readonly options: RenderChoiceOption[],
		private readonly onDone: (answer: ChoiceAnswer | null) => void,
	) {
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				this.inputMode = false;
				this.editor.setText("");
				this.refresh();
				return;
			}

			const letter = optionLetter(this.options.length - 1);
			this.onDone({ value: trimmed, label: trimmed, letter, wasCustom: true });
		};
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.editor.setText("");
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.selectCurrent();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const renderWidth = Math.max(1, width);

		const addWrapped = (text: string) => {
			lines.push(...wrapTextWithAnsi(text, renderWidth));
		};

		const addWrappedWithPrefix = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				addWrapped(prefix + text);
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			const continuationPrefix = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
			}
		};

		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
		addWrappedWithPrefix(" ", this.theme.fg("accent", this.theme.bold("Question")));
		addWrappedWithPrefix(" ", this.theme.fg("text", this.question));

		if (this.context?.trim()) {
			lines.push("");
			addWrappedWithPrefix(" ", this.theme.fg("muted", this.context.trim()));
		}

		lines.push("");
		for (let i = 0; i < this.options.length; i++) {
			const option = this.options[i];
			const selected = i === this.selectedIndex;
			const letter = optionLetter(i);
			const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
			const color = selected ? "accent" : option.isCustom ? "muted" : "text";
			const marker = option.isCustom && this.inputMode ? " ✎" : "";
			addWrappedWithPrefix(prefix, this.theme.fg(color, `${letter}. ${option.label}${marker}`));

			if (option.description) {
				addWrappedWithPrefix("     ", this.theme.fg("muted", option.description));
			}
		}

		if (this.inputMode) {
			lines.push("");
			addWrappedWithPrefix(" ", this.theme.fg("muted", "Your answer:"));
			for (const line of this.editor.render(Math.max(1, renderWidth - 2))) {
				lines.push(` ${line}`);
			}
		}

		lines.push("");
		if (this.inputMode) {
			addWrappedWithPrefix(" ", this.theme.fg("dim", "Enter submit • Esc return to choices"));
		} else {
			addWrappedWithPrefix(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
		}
		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private selectCurrent(): void {
		const option = this.options[this.selectedIndex];
		if (!option) return;

		if (option.isCustom) {
			this.inputMode = true;
			this.editor.setText("");
			this.refresh();
			return;
		}

		const letter = optionLetter(this.selectedIndex);
		this.onDone({
			value: option.value ?? option.label,
			label: option.label,
			letter,
			wasCustom: false,
			index: this.selectedIndex + 1,
		});
	}
}

export default function askModeExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let askToolSeenThisTurn = false;

	function applyActiveToolState(): void {
		const active = pi.getActiveTools();
		const hasTool = active.includes(TOOL_NAME);

		if (enabled && !hasTool) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!enabled && hasTool) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (enabled) {
			ctx.ui.setStatus(MODE_NAME, ctx.ui.theme.fg("accent", "? ask"));
		} else {
			ctx.ui.setStatus(MODE_NAME, undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry(MODE_NAME, { enabled });
	}

	function setEnabled(next: boolean, ctx: ExtensionContext, persist = true): void {
		enabled = next;
		applyActiveToolState();
		updateStatus(ctx);
		if (persist) persistState();
	}

	pi.registerCommand("askmode", {
		description: "Toggle ask mode, where the agent may ask one rich multiple-choice question at a time",
		handler: async (args, ctx) => {
			const action = normalizeArgs(args);

			if (action === "status") {
				ctx.ui.notify(`Ask mode is ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			const next = action === "toggle" ? !enabled : action === "on";
			setEnabled(next, ctx);
			ctx.ui.notify(
				next
					? "Ask mode enabled. The agent can use ask_user_choice for one question at a time."
					: "Ask mode disabled. The ask_user_choice tool is no longer active.",
				"info",
			);
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User",
		description:
			"Ask the user exactly one question with any number of concrete options plus an automatic custom-answer option. Use only while ask mode is enabled.",
		promptSnippet: "Ask the user one rich multiple-choice question and wait for the answer",
		promptGuidelines: [
			"Use ask_user_choice in ask mode when the user's preference, environment, or a technical tradeoff would materially affect what you do next.",
			"Ask_user_choice must ask exactly one question per tool call and must not be called more than once in the same assistant turn; wait for the user's answer before deciding whether another question is needed.",
			"When calling ask_user_choice, include every meaningful concrete option in options with detailed descriptions; do not impose an artificial maximum number of options.",
			"When a decision has two concrete choices, pass the two choices as options; ask_user_choice automatically appends a third custom-response choice for the user.",
			"Do not include an Other/custom option in ask_user_choice options because the UI automatically appends one at the end.",
		],
		parameters: AskUserChoiceParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled) {
				return {
					content: [
						{
							type: "text",
							text: "Ask mode is disabled. The user can enable it with /askmode on.",
						},
					],
					details: {
						question: params.question,
						context: params.context,
						options: params.options,
						answer: null,
						cancelled: true,
					} as ChoiceDetails,
				};
			}

			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: ask_user_choice requires Pi interactive TUI mode." }],
					details: {
						question: params.question,
						context: params.context,
						options: params.options,
						answer: null,
						cancelled: true,
					} as ChoiceDetails,
				};
			}

			const concreteOptions = params.options ?? [];
			if (concreteOptions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: ask_user_choice needs at least one concrete option." }],
					details: {
						question: params.question,
						context: params.context,
						options: [],
						answer: null,
						cancelled: true,
					} as ChoiceDetails,
				};
			}

			const options: RenderChoiceOption[] = [
				...concreteOptions,
				{ label: params.customOptionLabel ?? "Type your own answer.", isCustom: true },
			];

			const answer = await ctx.ui.custom<ChoiceAnswer | null>((tui, theme, _keybindings, done) => {
				return new AskChoiceComponent(tui, theme, params.question, params.context, options, done);
			});

			const details: ChoiceDetails = {
				question: params.question,
				context: params.context,
				options: concreteOptions,
				answer,
				cancelled: answer === null,
			};

			if (!answer) {
				return {
					content: [{ type: "text", text: "User cancelled the question." }],
					details,
				};
			}

			if (answer.wasCustom) {
				return {
					content: [{ type: "text", text: `User chose ${answer.letter} and wrote: ${answer.value}` }],
					details,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `User selected ${answer.letter}. ${answer.label} (value: ${answer.value})`,
					},
				],
				details,
			};
		},
		renderCall(args, theme, _context) {
			const opts = Array.isArray(args.options) ? (args.options as ChoiceOption[]) : [];
			const labels = [...opts.map((option, index) => `${optionLetter(index)}. ${option.label}`), `${optionLetter(opts.length)}. Custom`];
			let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.question ?? "");
			if (labels.length > 0) {
				text += `\n${theme.fg("dim", `  Choices: ${labels.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const details = result.details as ChoiceDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (!details.answer) {
				return new Text(theme.fg("warning", "Question cancelled or unavailable"), 0, 0);
			}

			const answer = details.answer;
			if (answer.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", `${answer.letter}. `) +
						theme.fg("muted", "custom: ") +
						answer.label,
					0,
				);
			}

			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `${answer.letter}. ${answer.label}`), 0, 0);
		},
	});

	pi.on("turn_start", async () => {
		askToolSeenThisTurn = false;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== TOOL_NAME) return;

		if (!enabled) {
			return {
				block: true,
				reason: "Ask mode is disabled. The user must run /askmode on before the ask_user_choice tool can be used.",
			};
		}

		if (askToolSeenThisTurn) {
			return {
				block: true,
				reason:
					"Ask mode allows only one ask_user_choice call per assistant turn. Wait for the first answer, then ask the next question in a later turn if still needed.",
			};
		}

		askToolSeenThisTurn = true;
	});

	pi.on("before_agent_start", async () => {
		if (!enabled) return;

		return {
			message: {
				customType: `${MODE_NAME}-context`,
				content: `[ASK MODE ACTIVE]
The user explicitly enabled ask mode with /askmode. Be more willing than usual to ask the user for input when their preference, constraints, environment, or a technical tradeoff would materially affect the next steps.

Use the ask_user_choice tool for these questions.

Rules:
- Ask exactly one question per ask_user_choice call.
- Do not call ask_user_choice more than once in the same assistant turn. Wait for the tool result before deciding whether to ask a follow-up question.
- The answer to the current question may affect the next question, so ask questions sequentially.
- Provide all meaningful concrete options; there is no artificial maximum number of options.
- If there are two concrete technical options, provide those two options. The UI will add a third custom-response option automatically.
- If there are six concrete technical options, provide all six. The UI will add a seventh custom-response option automatically.
- Each option should have a concise label and a detailed description with tradeoffs, implications, and when to choose it.
- Do not include an Other/custom option yourself; ask_user_choice appends it.
- Do not ask questions for trivial details when a safe, obvious default is available.`,
				display: false,
			},
		};
	});

	pi.on("context", async (event) => {
		if (enabled) return;
		return {
			messages: event.messages.filter((message) => {
				const customType = (message as { customType?: unknown }).customType;
				return customType !== `${MODE_NAME}-context`;
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = getModeState(ctx);
		applyActiveToolState();
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		enabled = getModeState(ctx);
		applyActiveToolState();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(MODE_NAME, undefined);
	});
}
