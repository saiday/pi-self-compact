import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "compact_session";
const STATUS_KEY = "self-compact";

interface Request {
	instructions?: string;
	resume?: string;
}

export default function (pi: ExtensionAPI) {
	/** A compaction requested during a turn, run once the turn settles. */
	let pending: Request | undefined;
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

	function notify(ctx: ExtensionContext, text: string, level: "info" | "error") {
		ifStillLive(() => ctx.ui.notify(text, level));
	}

	function formatUsage(ctx: ExtensionContext): string {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return "current context size unknown";
		const percent = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
		return `${usage.tokens.toLocaleString()} tokens, ${percent} of the ${usage.contextWindow.toLocaleString()}-token window`;
	}

	function clean(value: unknown): string | undefined {
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	}

	/**
	 * Start the next turn from the compacted context. Deferred off the current
	 * callback so the agent_settled emission finishes before a new run begins.
	 */
	function deliverResume(text: string) {
		setTimeout(() => {
			try {
				pi.sendUserMessage(text);
			} catch {
				// Session gone.
			}
		}, 0);
	}

	/**
	 * Run a compaction to completion. Only safe once the agent has settled:
	 * session.compact() aborts the active turn before it summarizes, so
	 * compacting from inside a tool call would kill the turn that asked for it.
	 *
	 * A failed compaction still has to reach the model. Silence leaves it
	 * believing a context it never got, and drops the queued follow-up work.
	 */
	async function compactNow(ctx: ExtensionContext, request: Request): Promise<void> {
		running = true;
		setStatus(ctx, "compacting…");
		try {
			await new Promise<void>((resolve) => {
				ctx.compact({
					customInstructions: request.instructions,
					onComplete: (result) => {
						const after =
							result.estimatedTokensAfter === undefined
								? "unknown"
								: result.estimatedTokensAfter.toLocaleString();
						notify(
							ctx,
							`Compacted: ${result.tokensBefore.toLocaleString()} tokens -> ~${after}.`,
							"info",
						);
						if (request.resume) {
							deliverResume(
								`[self-compact] The context you asked to compact is now a summary plus the most recent messages. ` +
									`Everything else is gone, so work from the files rather than from memory.\n\n` +
									`Continue with what you deferred until after the compaction:\n\n${request.resume}`,
							);
						}
						resolve();
					},
					onError: (error) => {
						notify(ctx, `Compaction failed: ${error.message}`, "error");
						if (request.resume) {
							deliverResume(
								`[self-compact] The compaction you requested did NOT run: ${error.message}. ` +
									`Your context is unchanged, and nothing was summarized or dropped. ` +
									`Do not claim it was compacted; say so if you already reported otherwise.\n\n` +
									`Continue with what you deferred until after the compaction:\n\n${request.resume}`,
							);
						} else {
							try {
								pi.sendMessage(
									{
										customType: TOOL_NAME,
										content: `The compaction you requested did NOT run: ${error.message}. Your context is unchanged. Do not claim it was compacted.`,
										display: true,
									},
									{ deliverAs: "nextTurn" },
								);
							} catch {
								// Session gone.
							}
						}
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
			"The compaction is queued and runs after the current turn ends, so this tool returns immediately and the summary is not visible in this turn. " +
			"Call it when the context is large enough to threaten the window, when the user or another agent asks this session to compact, or before starting unrelated work in the same session. " +
			"When you are asked to compact BEFORE doing a piece of work, put that work in `resume` and make this call the last thing you do in the turn: end your reply right after it and start no part of the work. " +
			"The work then runs in the next turn against the compacted context, which is the whole point of compacting first. " +
			"Compaction is lossy: detail outside the summary and the kept recent messages is gone afterwards, so finish or write down in-flight work first. Do not call it more than once per turn.",
		promptSnippet:
			"Compact this session's own context (queued, runs after the current turn ends; `resume` continues the work in the next turn).",
		parameters: Type.Object({
			instructions: Type.Optional(
				Type.String({
					description:
						"What the summary must preserve, e.g. 'keep the API schema decisions and the failing test names'. Omit for a general summary.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"What to do once the compaction has run. It is delivered to you as the next message, so write it as an instruction to yourself and make it self-contained: name the file to read and the task to continue, since the conversation it came from may be summarized away. Omit to simply stop after compacting.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const instructions = clean(params.instructions);
			const resume = clean(params.resume);

			if (running) {
				return {
					content: [{ type: "text", text: "A compaction is already running; nothing queued." }],
					details: { queued: false, reason: "running" },
				};
			}
			if (pending) {
				return {
					content: [
						{ type: "text", text: "A compaction is already queued for the end of this turn." },
					],
					details: { queued: false, reason: "already-queued" },
				};
			}

			pending = { instructions, resume };
			setStatus(ctx, "compaction queued");

			return {
				content: [
					{
						type: "text",
						text:
							`Compaction queued; it runs once this turn ends (${formatUsage(ctx)}).` +
							(instructions ? ` Summary instructions: ${instructions}` : "") +
							(resume
								? " End your reply now without starting the deferred work. Once the compaction has run, the resume instruction comes back to you as the next message and the work continues there."
								: " Finish your reply now. The next turn starts from the summary."),
					},
				],
				details: { queued: true, instructions, resume },
			};
		},
	});

	pi.registerCommand("self-compact", {
		description: "Compact this session (same as the compact_session tool)",
		handler: async (args, ctx) => {
			const instructions = clean(args);
			if (running) {
				ctx.ui.notify("A compaction is already running.", "warning");
				return;
			}
			if (ctx.isIdle()) {
				await compactNow(ctx, { instructions });
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
		const request = pending;
		pending = undefined;
		await compactNow(ctx, request);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pending = undefined;
		setStatus(ctx, undefined);
	});
}
