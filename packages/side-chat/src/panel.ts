import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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

type SideChatPanelOptions = {
	session: AgentSession;
	config: SideChatConfig;
	initialPrompt?: string;
	requestRender: () => void;
	done: (reason: PanelFinishReason) => void;
	onMerge: (request: MergeRequest) => void;
	onClose: () => void;
};

const SIDE_PROMPT = "side> ";

function isPrintable(data: string): boolean {
	return data.length > 0 && !data.startsWith("\x1b") && !/^[\x00-\x1f\x7f]$/.test(data);
}

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

export class SideChatPanel implements Component {
	private lines: ChatLine[] = [];
	private input = "";
	private running = false;
	private currentAssistantIndex: number | undefined;
	private unsubscribe?: () => void;
	private sideEffects = false;
	private closeConfirmationArmed = false;
	private disposed = false;

	constructor(private readonly options: SideChatPanelOptions) {
		this.lines.push({ role: "system", text: "Side chat started. Type /help for local commands." });
		this.unsubscribe = options.session.subscribe((event) => this.onSessionEvent(event));
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
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.disposed) return;

		if (matchesKey(data, Key.enter)) {
			const value = this.input.trim();
			this.input = "";
			void this.submit(value);
			this.options.requestRender();
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			this.input = this.input.slice(0, -1);
			this.options.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			void this.abort();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			void this.close(false);
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.input = "";
			this.options.requestRender();
			return;
		}

		if (isPrintable(data)) {
			this.input += data;
			this.options.requestRender();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const lines: string[] = [];
		const top = `╭${"─".repeat(innerWidth)}╮`;
		const bottom = `╰${"─".repeat(innerWidth)}╯`;
		lines.push(top);
		lines.push(this.boxLine("Side Chat · read-mostly · /help", innerWidth));
		lines.push(this.boxLine("─".repeat(innerWidth), innerWidth));

		const renderedTranscript = this.renderTranscript(innerWidth);
		for (const line of renderedTranscript) lines.push(this.boxLine(line, innerWidth));

		lines.push(this.boxLine("─".repeat(innerWidth), innerWidth));
		const status = this.running ? "streaming… Ctrl+C abort" : "Enter send · /merge · /close";
		lines.push(this.boxLine(status, innerWidth));
		lines.push(this.boxLine(`${SIDE_PROMPT}${this.input}`, innerWidth));
		lines.push(bottom);
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	private renderTranscript(width: number): string[] {
		const rawLines: string[] = [];
		for (const line of this.lines) {
			const label = this.labelForRole(line.role);
			const text = line.text || " ";
			const wrapped = wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(label)));
			if (wrapped.length === 0) {
				rawLines.push(label);
			} else {
				rawLines.push(`${label}${wrapped[0]}`);
				for (const continuation of wrapped.slice(1)) rawLines.push(`${" ".repeat(visibleWidth(label))}${continuation}`);
			}
		}

		const max = this.options.config.panel.maxTranscriptLines;
		if (rawLines.length <= max) return rawLines;
		return [`… ${rawLines.length - max} earlier line(s) hidden`, ...rawLines.slice(-max)];
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
		await this.submitPrompt(value);
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
					"/help   show this help",
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
