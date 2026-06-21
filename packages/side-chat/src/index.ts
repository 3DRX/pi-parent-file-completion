import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadSideChatConfig } from "./config.ts";
import { type MergeRequest, type PanelFinishReason, SideChatPanel } from "./panel.ts";

const SIDE_CHAT_SYSTEM_PROMPT = `You are in a side chat forked from the user's main Pi conversation.

This is an exploratory side conversation. Prefer explanation, analysis, inspection, and read-only project exploration.

Default behavior:
- Prefer read-only tools and safe inspection: read files, search, inspect logs, and explain findings.
- Avoid editing, writing, deleting, moving, or committing files unless the user's latest side-chat request explicitly asks you to make a change.
- If a change seems useful but was not explicitly requested, propose it instead of applying it.
- If the user explicitly asks you to implement, modify, fix, update, create, delete, run a command, or otherwise take action, you may use the normal tools needed to complete that request.
- Keep responses focused; this side chat is meant to support the main thread, not replace it.`;

type ParentSnapshot = {
	sessionFile: string | undefined;
	leafId: string | null;
	entryCount: number;
};

function snapshotParent(ctx: ExtensionCommandContext): ParentSnapshot {
	return {
		sessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId(),
		entryCount: ctx.sessionManager.getEntries().length,
	};
}

function parentUnchanged(ctx: ExtensionCommandContext, snapshot: ParentSnapshot): boolean {
	return (
		ctx.sessionManager.getSessionFile() === snapshot.sessionFile &&
		ctx.sessionManager.getLeafId() === snapshot.leafId &&
		ctx.sessionManager.getEntries().length === snapshot.entryCount
	);
}

async function deleteSessionFile(path: string | undefined): Promise<void> {
	if (!path || !existsSync(path)) return;
	await unlink(path);
}

function createSideSessionManager(ctx: ExtensionCommandContext): { manager: SessionManager; file: string | undefined } {
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const leafId = ctx.sessionManager.getLeafId();

	if (!parentSessionFile || !leafId) {
		const manager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir(), {
			parentSession: parentSessionFile,
		});
		manager.appendSessionInfo("Side chat");
		return { manager, file: manager.getSessionFile() };
	}

	const manager = SessionManager.open(parentSessionFile, ctx.sessionManager.getSessionDir(), ctx.cwd);
	const file = manager.createBranchedSession(leafId);
	manager.appendSessionInfo("Side chat");
	return { manager, file };
}

function buildMergeMarkdown(transcriptMarkdown: string): string {
	return `## Side chat merged\n\n${transcriptMarkdown}`;
}

export default function sideChatExtension(pi: ExtensionAPI): void {
	pi.registerCommand("side", {
		description: "Open an ephemeral side chat forked from the current conversation",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/side requires interactive TUI mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("/side requires a selected model", "error");
				return;
			}

			const { config, warnings } = loadSideChatConfig(ctx);
			for (const warning of warnings) ctx.ui.notify(warning, "warning");

			const parentSnapshot = snapshotParent(ctx);
			const { manager: sideSessionManager, file: initialSideFile } = createSideSessionManager(ctx);
			let sideSessionFile = initialSideFile;
			let panel: SideChatPanel | undefined;
			let finishReason: PanelFinishReason = "close";
			let merged = false;

			const loader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				appendSystemPrompt: [SIDE_CHAT_SYSTEM_PROMPT],
			});
			await loader.reload();

			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				modelRegistry: ctx.modelRegistry,
				resourceLoader: loader,
				sessionManager: sideSessionManager,
				tools: pi.getActiveTools(),
			});

			try {
				finishReason = await ctx.ui.custom<PanelFinishReason>(
					(tui, _theme, _keybindings, done) => {
						panel = new SideChatPanel({
							session,
							config,
							initialPrompt: args.trim() || undefined,
							requestRender: () => tui.requestRender(),
							done,
							onClose: () => {
								finishReason = "close";
							},
							onMerge: (request: MergeRequest) => {
								if (config.merge.requireParentUnchanged && !parentUnchanged(ctx, parentSnapshot)) {
									ctx.ui.notify(
										"Cannot merge side chat: the main session changed after the side chat was opened.",
										"error",
									);
									request.resolve(false);
									return;
								}

								pi.sendMessage(
									{
										customType: "side-chat-merge",
										content: buildMergeMarkdown(request.transcriptMarkdown),
										display: true,
										details: {
											parentLeafId: parentSnapshot.leafId,
											sideSessionFile: session.sessionFile,
										},
									},
									{ triggerTurn: false },
								);
								merged = true;
								finishReason = "merge";
								request.resolve(true);
							},
						});
						return panel;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "right-center",
							width: config.panel.width,
							maxHeight: config.panel.maxHeight,
							margin: config.panel.margin,
						},
					},
				);
			} finally {
				panel?.dispose();
				await session.abort().catch(() => undefined);
				session.dispose();
				sideSessionFile = session.sessionFile ?? sideSessionFile;
				const shouldDelete = finishReason === "merge" ? config.session.deleteOnMerge : config.session.deleteOnClose;
				if (shouldDelete) {
					try {
						await deleteSessionFile(sideSessionFile);
					} catch (error) {
						ctx.ui.notify(
							`Side chat ${finishReason === "merge" ? "merged" : "closed"}, but failed to delete temporary session: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				}
			}

			if (merged) {
				ctx.ui.notify("Side chat merged into the main session.", "info");
			} else {
				ctx.ui.notify("Side chat closed.", "info");
			}
		},
	});
}
