import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "compact_session";
const STATUS_KEY = "self-compact";

export default function (pi: ExtensionAPI) {
	/** Instructions for a compaction requested during a turn, run once the turn settles. */
	let pending: { instructions?: string } | undefined;
	let running = false;

	/**
	 * Compaction callbacks can land after the session has torn down, and every
	 * ctx accessor throws once the extension runner goes inactive. Nothing is
	 * listening then, so drop the report rather than crash the process.
	 */
	function ifStillLive(report: () => void) {
		try {
			report();
		} catch {
			// Session gone.
		}
	}

	function setStatus(ctx: ExtensionContext, text: string | undefined) {
		ifStillLive(() => {
			if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, text);
		});
	}

	function formatUsage(ctx: ExtensionContext): string {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return "current context size unknown";
		const percent = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
		return `${usage.tokens.toLocaleString()} tokens, ${percent} of the ${usage.contextWindow.toLocaleString()}-token window`;
	}

	/**
	 * Run a compaction to completion. Only safe once the agent has settled:
	 * session.compact() aborts the active turn before it summarizes, so
	 * compacting from inside a tool call would kill the turn that asked for it.
	 */
	async function compactNow(ctx: ExtensionContext, instructions?: string): Promise<void> {
		running = true;
		setStatus(ctx, "compacting…");
		try {
			await new Promise<void>((resolve) => {
				ctx.compact({
					customInstructions: instructions,
					onComplete: (result) => {
						const after =
							result.estimatedTokensAfter === undefined
								? "unknown"
								: result.estimatedTokensAfter.toLocaleString();
						ifStillLive(() =>
							ctx.ui.notify(
								`Compacted: ${result.tokensBefore.toLocaleString()} tokens -> ~${after}.`,
								"info",
							),
						);
						resolve();
					},
					onError: (error) => {
						ifStillLive(() => ctx.ui.notify(`Compaction failed: ${error.message}`, "error"));
						resolve();
					},
				});
			});
		} finally {
			running = false;
			setStatus(ctx, undefined);
		}
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Compact Session",
		description:
			"Compact this session's own context: summarize the earlier conversation and drop the summarized messages, keeping the recent ones. " +
			"The compaction is queued and runs after the current turn finishes, so this tool returns immediately and the summary is not visible in this turn. " +
			"Call it when the context is large enough to threaten the window, when the user or another agent asks this session to compact, or before starting unrelated work in the same session. " +
			"Compaction is lossy: detail outside the summary and the kept recent messages is gone afterwards, so finish or write down in-flight work first. Do not call it more than once per turn.",
		promptSnippet:
			"Compact this session's own context (queued, runs after the current turn ends).",
		parameters: Type.Object({
			instructions: Type.Optional(
				Type.String({
					description:
						"What the summary must preserve, e.g. 'keep the API schema decisions and the failing test names'. Omit for a general summary.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const instructions =
				typeof params.instructions === "string" && params.instructions.trim().length > 0
					? params.instructions.trim()
					: undefined;

			if (running) {
				return {
					content: [{ type: "text", text: "A compaction is already running; nothing queued." }],
					details: { queued: false, reason: "running" },
				};
			}
			if (pending) {
				return {
					content: [{ type: "text", text: "A compaction is already queued for the end of this turn." }],
					details: { queued: false, reason: "already-queued" },
				};
			}

			pending = { instructions };
			setStatus(ctx, "compaction queued");

			return {
				content: [
					{
						type: "text",
						text:
							`Compaction queued; it runs once this turn ends (${formatUsage(ctx)}).` +
							(instructions ? ` Summary instructions: ${instructions}` : "") +
							" Finish your reply now. The next turn starts from the summary.",
					},
				],
				details: { queued: true, instructions },
			};
		},
	});

	pi.registerCommand("self-compact", {
		description: "Compact this session (same as the compact_session tool)",
		handler: async (args, ctx) => {
			const instructions = args.trim().length > 0 ? args.trim() : undefined;
			if (running) {
				ctx.ui.notify("A compaction is already running.", "warning");
				return;
			}
			if (ctx.isIdle()) {
				await compactNow(ctx, instructions);
				return;
			}
			pending = { instructions };
			setStatus(ctx, "compaction queued");
			ctx.ui.notify("Compaction queued; it runs when the agent goes idle.", "info");
		},
	});

	// The session is already marked idle when this fires, so compacting here
	// neither aborts a live turn nor deadlocks on waitForIdle. Awaiting it holds
	// the run open until the summary is written, which is what keeps compaction
	// from being cut short by shutdown in --print mode.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!pending || running) return;
		const { instructions } = pending;
		pending = undefined;
		await compactNow(ctx, instructions);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pending = undefined;
		setStatus(ctx, undefined);
	});
}
