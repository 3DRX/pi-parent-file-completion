import type { AgentSession, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	Editor,
	Key,
	matchesKey,
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SideChatConfig } from "./config.ts";

export type PanelFinishReason = "close" | "merge";

export type MergeRequest = {
	transcriptMarkdown: string;
	resolve: (accepted: boolean) => void;
};

type ChatLine = {
	role: "system" | "user" | "assistant" | "tool" | "error";
	text: string;
};

type SideChatEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type SideChatPanelOptions = {
	session: AgentSession;
	config: SideChatConfig;
	initialPrompt?: string;
	requestRender: () => void;
	done: (reason: PanelFinishReason) => void;
	onMerge: (request: MergeRequest) => void;
	onClose: () => void;
	onHide: () => void;
	getTerminalRows: () => number;
	getTerminalColumns: () => number;
	tui: TUI;
	editorTheme: EditorTheme;
	keybindings: KeybindingsManager;
	autocompleteProvider?: AutocompleteProvider;
	editorFactory?: SideChatEditorFactory;
};

const MOUSE_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE_SEQUENCE = "\x1b[?1006l\x1b[?1000l";
const TRANSCRIPT_KEY_SCROLL_LINES = 5;
const TRANSCRIPT_WHEEL_SCROLL_LINES = 3;
const AUTOCOMPLETE_EXTRA_INPUT_LINES = 6;

type MouseWheelEvent = {
	direction: "up" | "down";
	x: number;
	y: number;
};

function normalizeAssistantDelta(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const e = event as { type?: unknown; delta?: unknown };
	if ((e.type === "text_delta" || e.type === "thinking_delta") && typeof e.delta === "string") return e.delta;
	return undefined;
}

function toolNameFromEvent(event: unknown): string {
	if (!event || typeof event !== "object") return "tool";
	const e = event as { toolName?: unknown };
	return typeof e.toolName === "string" ? e.toolName : "tool";
}

function resolveSize(value: number | `${number}%`, total: number): number {
	if (typeof value === "number") return Math.floor(value);
	const percent = Number(value.slice(0, -1));
	if (!Number.isFinite(percent)) return total;
	return Math.floor((total * percent) / 100);
}

function isCtrlArrowUp(data: string): boolean {
	return matchesKey(data, Key.ctrl(Key.up)) || data === "\x1b[1;5A" || data === "\x1b[5A";
}

function isCtrlArrowDown(data: string): boolean {
	return matchesKey(data, Key.ctrl(Key.down)) || data === "\x1b[1;5B" || data === "\x1b[5B";
}

function isCtrlHome(data: string): boolean {
	return matchesKey(data, Key.ctrl(Key.home)) || data === "\x1b[1;5H" || data === "\x1b[5H";
}

function isCtrlEnd(data: string): boolean {
	return matchesKey(data, Key.ctrl(Key.end)) || data === "\x1b[1;5F" || data === "\x1b[5F";
}

function parseMouseWheel(data: string): MouseWheelEvent | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgr) {
		if (sgr[4] !== "M") return undefined;
		const button = Number(sgr[1]);
		const x = Number(sgr[2]);
		const y = Number(sgr[3]);
		const wheelButton = button & ~28; // remove shift/meta/ctrl modifier bits
		if (wheelButton === 64) return { direction: "up", x, y };
		if (wheelButton === 65) return { direction: "down", x, y };
		return undefined;
	}

	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const button = data.charCodeAt(3) - 32;
		const x = data.charCodeAt(4) - 32;
		const y = data.charCodeAt(5) - 32;
		const wheelButton = button & ~28;
		if (wheelButton === 64) return { direction: "up", x, y };
		if (wheelButton === 65) return { direction: "down", x, y };
	}

	return undefined;
}

export class SideChatPanel implements Component, Focusable {
	private lines: ChatLine[] = [];
	private readonly editor: EditorComponent;
	private running = false;
	private currentAssistantIndex: number | undefined;
	private unsubscribe?: () => void;
	private sideEffects = false;
	private closeConfirmationArmed = false;
	private disposed = false;
	private transcriptScrollOffset = 0;
	private lastRenderWidth = 0;
	private lastRenderHeight = 0;
	private mouseEnabled = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		const focusableEditor = this.editor as EditorComponent & Partial<Focusable>;
		if ("focused" in focusableEditor) focusableEditor.focused = value;
	}

	constructor(private readonly options: SideChatPanelOptions) {
		this.editor = options.editorFactory?.(options.tui, options.editorTheme, options.keybindings) ?? new Editor(options.tui, options.editorTheme, { paddingX: 0, autocompleteMaxVisible: 5 });
		this.editor.setPaddingX?.(0);
		this.editor.setAutocompleteMaxVisible?.(5);
		if (options.autocompleteProvider) this.editor.setAutocompleteProvider?.(options.autocompleteProvider);
		this.editor.onSubmit = (value) => {
			const text = value.trim();
			if (text) this.editor.addToHistory?.(text);
			this.editor.setText("");
			void this.submit(text);
			this.options.requestRender();
		};
		this.editor.onChange = () => this.options.requestRender();
		this.lines.push({ role: "system", text: "Side chat started. Type /help for local commands." });
		this.unsubscribe = options.session.subscribe((event) => this.onSessionEvent(event));
		this.setMouseEnabled(true);
		if (options.initialPrompt?.trim()) {
			queueMicrotask(() => void this.submitPrompt(options.initialPrompt!.trim()));
		}
	}

	getHadSideEffects(): boolean {
		return this.sideEffects;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.setMouseEnabled(false);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	handleInput(data: string): void {
		if (this.disposed) return;

		if (matchesKey(data, Key.ctrl("c"))) {
			void this.abort();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.shouldDelegateEscapeToEditor()) {
				this.editor.handleInput(data);
				this.options.requestRender();
				return;
			}
			this.options.onHide();
			return;
		}

		if (isCtrlHome(data)) {
			this.scrollTranscriptToTop();
			return;
		}

		if (isCtrlEnd(data)) {
			this.scrollTranscriptToBottom();
			return;
		}

		if (isCtrlArrowUp(data)) {
			this.scrollTranscript(TRANSCRIPT_KEY_SCROLL_LINES);
			return;
		}

		if (isCtrlArrowDown(data)) {
			this.scrollTranscript(-TRANSCRIPT_KEY_SCROLL_LINES);
			return;
		}

		const mouseWheel = parseMouseWheel(data);
		if (mouseWheel) {
			if (this.isMouseWithinPanel(mouseWheel.x, mouseWheel.y)) {
				this.scrollTranscript(mouseWheel.direction === "up" ? TRANSCRIPT_WHEEL_SCROLL_LINES : -TRANSCRIPT_WHEEL_SCROLL_LINES);
			}
			return;
		}

		this.editor.handleInput(data);
		this.options.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const terminalRows = Math.max(1, this.options.getTerminalRows());
		const margin = this.options.config.panel.margin;
		const availableRows = Math.max(1, terminalRows - margin * 2);
		const configuredHeight = resolveSize(this.options.config.panel.height, terminalRows);
		const configuredMaxHeight = Math.min(resolveSize(this.options.config.panel.maxHeight, terminalRows), availableRows);
		const inputLines = this.renderInput(innerWidth);
		const fixedRows = 6 + inputLines.length; // borders, title, separators, status, input
		const targetHeight = Math.max(
			fixedRows + 1,
			Math.min(configuredMaxHeight, Math.max(this.options.config.panel.minHeight, configuredHeight)),
		);
		const transcriptHeight = Math.max(1, targetHeight - fixedRows);
		const renderedTranscript = this.renderTranscript(innerWidth, transcriptHeight);

		const lines: string[] = [];
		const top = `╭${"─".repeat(innerWidth)}╮`;
		const bottom = `╰${"─".repeat(innerWidth)}╯`;
		lines.push(top);
		lines.push(this.boxLine("Side Chat · read-mostly · /help", innerWidth));
		lines.push(this.boxLine("─".repeat(innerWidth), innerWidth));

		for (const line of renderedTranscript) lines.push(this.boxLine(line, innerWidth));

		lines.push(this.boxLine("─".repeat(innerWidth), innerWidth));
		const status = this.running ? "streaming… Ctrl+C abort · Esc hide" : "Enter send · Tab complete · Esc hide · /close delete";
		lines.push(this.boxLine(status, innerWidth));
		for (const line of inputLines) lines.push(this.boxLine(line, innerWidth));
		lines.push(bottom);

		while (lines.length < targetHeight) {
			lines.splice(lines.length - 1, 0, this.boxLine("", innerWidth));
		}

		this.lastRenderWidth = safeWidth;
		this.lastRenderHeight = targetHeight;
		return lines.slice(0, targetHeight).map((line) => truncateToWidth(line, safeWidth, ""));
	}

	private renderTranscript(width: number, viewportHeight: number): string[] {
		const rawLines: string[] = [];
		this.lines.forEach((line, index) => {
			if (index > 0 && (line.role === "user" || line.role === "assistant")) rawLines.push("");
			const label = this.labelForRole(line.role);
			const text = line.text || " ";
			const rendered = this.renderMarkdownText(text, Math.max(1, width - visibleWidth(label)));
			if (rendered.length === 0) {
				rawLines.push(label);
			} else {
				rawLines.push(`${label}${rendered[0]}`);
				for (const continuation of rendered.slice(1)) rawLines.push(`${" ".repeat(visibleWidth(label))}${continuation}`);
			}
		});

		const maxOffset = Math.max(0, rawLines.length - viewportHeight);
		this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxOffset));

		const end = rawLines.length - this.transcriptScrollOffset;
		const start = Math.max(0, end - viewportHeight);
		const visible = rawLines.slice(start, end);

		if (start > 0 && visible.length > 0) visible[0] = `… ${start} earlier line(s) hidden`;
		if (end < rawLines.length && visible.length > 0) visible[visible.length - 1] = `… ${rawLines.length - end} later line(s) hidden`;
		return [...visible, ...Array.from({ length: viewportHeight - visible.length }, () => "")];
	}

	private renderMarkdownText(text: string, width: number): string[] {
		const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
		return markdown.render(width).flatMap((line) => wrapTextWithAnsi(line, width));
	}

	private renderInput(width: number): string[] {
		const editorLines = this.editor.render(width);
		const maxInputLines = Math.max(1, this.options.config.panel.maxInputLines);
		const maxVisibleLines = this.isAutocompleteShowing()
			? maxInputLines + AUTOCOMPLETE_EXTRA_INPUT_LINES
			: maxInputLines;
		if (editorLines.length <= maxVisibleLines) return editorLines;
		return [`… ${editorLines.length - maxVisibleLines + 1} earlier input line(s)`, ...editorLines.slice(-(maxVisibleLines - 1))];
	}

	private isAutocompleteShowing(): boolean {
		const isShowingAutocomplete = (this.editor as EditorComponent & { isShowingAutocomplete?: () => boolean })
			.isShowingAutocomplete;
		return typeof isShowingAutocomplete === "function" && isShowingAutocomplete.call(this.editor);
	}

	private boxLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "…");
		const pad = Math.max(0, innerWidth - visibleWidth(truncated));
		return `│${truncated}${" ".repeat(pad)}│`;
	}

	private labelForRole(role: ChatLine["role"]): string {
		switch (role) {
			case "user":
				return "you: ";
			case "assistant":
				return "ai:  ";
			case "tool":
				return "tool:";
			case "error":
				return "err: ";
			case "system":
				return "· ";
		}
	}

	private async submit(value: string): Promise<void> {
		if (!value) return;
		this.closeConfirmationArmed = false;
		if (value.startsWith("/")) {
			await this.handleLocalCommand(value);
			return;
		}
		this.transcriptScrollOffset = 0;
		await this.submitPrompt(value);
	}

	submitExternalPrompt(prompt: string): void {
		const text = prompt.trim();
		if (!text) return;
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.transcriptScrollOffset = 0;
		void this.submitPrompt(text);
		this.options.requestRender();
	}

	setTemporarilyHidden(hidden: boolean): void {
		this.setMouseEnabled(!hidden);
	}

	private setMouseEnabled(enabled: boolean): void {
		if (this.mouseEnabled === enabled) return;
		this.mouseEnabled = enabled;
		this.options.tui.terminal.write(enabled ? MOUSE_ENABLE_SEQUENCE : MOUSE_DISABLE_SEQUENCE);
	}

	private shouldDelegateEscapeToEditor(): boolean {
		const getMode = (this.editor as EditorComponent & { getMode?: () => unknown }).getMode;
		if (!getMode) return false;
		const mode = getMode.call(this.editor);
		return String(mode).toLowerCase() === "insert";
	}

	private scrollTranscript(delta: number): void {
		this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
		this.options.requestRender();
	}

	private scrollTranscriptToTop(): void {
		this.transcriptScrollOffset = Number.MAX_SAFE_INTEGER;
		this.options.requestRender();
	}

	private scrollTranscriptToBottom(): void {
		this.transcriptScrollOffset = 0;
		this.options.requestRender();
	}

	private isMouseWithinPanel(mouseX: number, mouseY: number): boolean {
		if (this.lastRenderWidth <= 0 || this.lastRenderHeight <= 0) return false;
		const termWidth = Math.max(1, this.options.getTerminalColumns());
		const termHeight = Math.max(1, this.options.getTerminalRows());
		const margin = this.options.config.panel.margin;
		const availableHeight = Math.max(1, termHeight - margin * 2);
		const height = Math.min(this.lastRenderHeight, availableHeight);
		const left = Math.max(0, termWidth - margin - this.lastRenderWidth);
		const top = margin;
		const x = mouseX - 1;
		const y = mouseY - 1;
		return x >= left && x < left + this.lastRenderWidth && y >= top && y < top + height;
	}

	private async handleLocalCommand(commandLine: string): Promise<void> {
		const [commandWithSlash] = commandLine.split(/\s+/, 1);
		const command = commandWithSlash?.slice(1).toLowerCase();
		switch (command) {
			case "help":
				this.addSystem([
					"Local commands:",
					"/merge  merge this side chat into the parent session and close",
					"/close  close and delete the side-chat session",
					"/close! force close when side effects were detected",
					"/abort  abort the current side response",
					"/bottom jump to latest transcript content",
					"/help   show this help",
					"Esc hides the panel without closing it; run /side in the main editor to restore.",
					"Keys: Tab autocomplete; ↑/↓ browse input history; Ctrl+↑/Ctrl+↓ scroll transcript; Ctrl+Home/Ctrl+End jump transcript; mouse wheel scrolls when hovering the panel.",
				].join("\n"));
				break;
			case "merge":
				await this.merge();
				break;
			case "close":
				await this.close(false);
				break;
			case "close!":
				await this.close(true);
				break;
			case "abort":
				await this.abort();
				break;
			case "bottom":
				this.scrollTranscriptToBottom();
				break;
			default:
				this.addSystem(`Unknown side-chat command: /${command}. Type /help.`);
		}
		this.options.requestRender();
	}

	private async submitPrompt(prompt: string): Promise<void> {
		if (this.running) {
			this.addSystem("Side agent is busy. Type /abort first, or wait for it to finish.");
			this.options.requestRender();
			return;
		}

		this.lines.push({ role: "user", text: prompt });
		this.running = true;
		this.currentAssistantIndex = undefined;
		this.options.requestRender();

		try {
			await this.options.session.prompt(prompt, { source: "extension" });
		} catch (error) {
			this.lines.push({ role: "error", text: error instanceof Error ? error.message : String(error) });
		} finally {
			this.running = false;
			this.currentAssistantIndex = undefined;
			this.options.requestRender();
		}
	}

	private async abort(): Promise<void> {
		if (!this.running) {
			this.addSystem("Nothing to abort.");
			this.options.requestRender();
			return;
		}
		await this.options.session.abort();
		this.addSystem("Aborted.");
		this.options.requestRender();
	}

	private async merge(): Promise<void> {
		if (this.running) {
			this.addSystem("Side agent is still running. Type /abort or wait before merging.");
			this.options.requestRender();
			return;
		}

		const transcriptMarkdown = this.toMarkdown();
		const accepted = await new Promise<boolean>((resolve) => {
			this.options.onMerge({ transcriptMarkdown, resolve });
		});
		if (!accepted) {
			this.addSystem("Merge blocked. The side chat remains open.");
			this.options.requestRender();
			return;
		}
		this.options.done("merge");
	}

	private async close(force: boolean): Promise<void> {
		if (this.running) {
			this.addSystem("Side agent is still running. Type /abort before closing.");
			this.options.requestRender();
			return;
		}
		if (this.sideEffects && !force && !this.closeConfirmationArmed) {
			this.closeConfirmationArmed = true;
			this.addSystem("Side effects were detected. Type /close! to discard the transcript anyway.");
			this.options.requestRender();
			return;
		}
		this.options.onClose();
		this.options.done("close");
	}

	private onSessionEvent(event: unknown): void {
		if (!event || typeof event !== "object") return;
		const e = event as { type?: unknown; assistantMessageEvent?: unknown; isError?: unknown; toolName?: unknown };

		if (e.type === "message_update") {
			const delta = normalizeAssistantDelta(e.assistantMessageEvent);
			if (delta) this.appendAssistantDelta(delta);
		}

		if (e.type === "tool_execution_start") {
			const toolName = toolNameFromEvent(e);
			this.lines.push({ role: "tool", text: ` ${toolName} started` });
		}

		if (e.type === "tool_execution_end") {
			const toolName = toolNameFromEvent(e);
			if (toolName === "edit" || toolName === "write" || toolName === "bash") this.sideEffects = true;
			this.lines.push({ role: e.isError ? "error" : "tool", text: ` ${toolName} ${e.isError ? "failed" : "finished"}` });
		}

		this.options.requestRender();
	}

	private appendAssistantDelta(delta: string): void {
		if (this.currentAssistantIndex === undefined) {
			this.lines.push({ role: "assistant", text: "" });
			this.currentAssistantIndex = this.lines.length - 1;
		}
		const line = this.lines[this.currentAssistantIndex];
		if (line) line.text += delta;
	}

	private addSystem(text: string): void {
		this.lines.push({ role: "system", text });
	}

	private toMarkdown(): string {
		const usefulLines = this.lines.filter((line) => line.role === "user" || line.role === "assistant" || line.role === "tool" || line.role === "error");
		if (usefulLines.length === 0) return "_No side-chat messages._";
		return usefulLines
			.map((line) => {
				switch (line.role) {
					case "user":
						return `### User\n\n${line.text}`;
					case "assistant":
						return `### Side assistant\n\n${line.text}`;
					case "tool":
						return `> Tool: ${line.text}`;
					case "error":
						return `> Error: ${line.text}`;
					case "system":
						return "";
				}
			})
			.filter(Boolean)
			.join("\n\n");
	}
}
