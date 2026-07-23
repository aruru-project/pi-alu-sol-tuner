import { Agent, type AgentLoopConfig, type ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "sol-mid-turn-guard";
const STATUS_KEY = EXTENSION_ID;
const TARGET_MODEL_ID = "gpt-5.6-sol";
const TOKEN_THRESHOLD = 250_000;
const SUPPORTED_PI_VERSIONS = new Set(["0.80.6", "0.80.7"]);
const PATCH_KEY = Symbol.for("pi.sol-mid-turn-guard.patch.v2");
const LEGACY_PATCH_KEY = Symbol.for("pi.sol-mid-turn-guard.patch.v1");

const CONTINUATION_MESSAGE =
	"Automatic context compaction completed after a finished tool turn. Continue the original task from the compacted state. Do not repeat completed work or tool calls. If the requested task is already complete, finish normally now.";

type GuardPhase = "idle" | "stopped" | "compacting";

type AgentInternals = Agent & {
	createLoopConfig(options?: { skipInitialSteeringPoll?: boolean }): AgentLoopConfig;
};

interface GuardController {
	readonly generation: symbol;
	shouldStop(agent: Agent, turn: ShouldStopAfterTurnContext): Promise<boolean>;
	onNativeHookDetected(): void;
	reportShimError(error: unknown): void;
}

interface PatchHost {
	readonly original: AgentInternals["createLoopConfig"];
	readonly wrapper: AgentInternals["createLoopConfig"];
	readonly controllers: Map<string, GuardController>;
}

interface LegacyPatchHost {
	readonly original: AgentInternals["createLoopConfig"];
	readonly wrapper: AgentInternals["createLoopConfig"];
	controller?: GuardController;
}

function getPatchHost(): PatchHost | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[PATCH_KEY] as PatchHost | undefined;
}

function getLegacyPatchHost(): LegacyPatchHost | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[LEGACY_PATCH_KEY] as LegacyPatchHost | undefined;
}

function setPatchHost(host: PatchHost): void {
	(globalThis as Record<PropertyKey, unknown>)[PATCH_KEY] = host;
}

function usageTokens(turn: ShouldStopAfterTurnContext): number {
	const usage = turn.message.usage;
	if (!usage) return 0;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

function installPatch(): { active: boolean; reason?: string } {
	if (!SUPPORTED_PI_VERSIONS.has(VERSION)) {
		return { active: false, reason: `unsupported Pi ${VERSION}` };
	}

	const prototype = Agent.prototype as unknown as AgentInternals;
	let host = getPatchHost();

	if (!host) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "createLoopConfig");
		const legacy = getLegacyPatchHost();
		const legacyIsInstalled = legacy && descriptor?.value === legacy.wrapper;
		const original = (legacyIsInstalled ? legacy.original : descriptor?.value) as
			| AgentInternals["createLoopConfig"]
			| undefined;
		if (typeof original !== "function") {
			return { active: false, reason: "Agent.createLoopConfig is unavailable" };
		}
		if (legacyIsInstalled) legacy.controller = undefined;

		host = {
			original,
			controllers: new Map(),
			wrapper: function (this: AgentInternals, options) {
				const config = original.call(this, options);
				const sessionId = config.sessionId;
				const current = sessionId ? host?.controllers.get(sessionId) : undefined;
				if (!current) return config;

				if (typeof config.shouldStopAfterTurn === "function") {
					current.onNativeHookDetected();
					return config;
				}

				return {
					...config,
					shouldStopAfterTurn: async (turn) => {
						const live = sessionId ? host?.controllers.get(sessionId) : undefined;
						if (!live) return false;
						try {
							return await live.shouldStop(this, turn);
						} catch (error) {
							live.reportShimError(error);
							return false;
						}
					},
				};
			},
		};

		Object.defineProperty(prototype, "createLoopConfig", {
			...descriptor,
			value: host.wrapper,
		});
		setPatchHost(host);
	} else if (prototype.createLoopConfig !== host.wrapper) {
		return { active: false, reason: "Agent.createLoopConfig was patched by another runtime" };
	}

	return { active: true };
}

export default function solMidTurnGuard(pi: ExtensionAPI): void {
	const generation = Symbol("sol-mid-turn-guard-generation");
	let phase: GuardPhase = "idle";
	let latestContext: ExtensionContext | undefined;
	let stoppedTokens = 0;
	let nativeCompacted = false;
	let nativeHookDetected = false;
	let continuationCount = 0;
	let lastError: string | undefined;
	let activeSessionId: string | undefined;

	const resetCycle = () => {
		phase = "idle";
		stoppedTokens = 0;
		nativeCompacted = false;
	};

	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (latestContext?.hasUI) latestContext.ui.notify(message, level);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const controller: GuardController = {
		generation,
		async shouldStop(agent, turn) {
			if (phase !== "idle" || nativeHookDetected) return false;
			if (turn.message.model !== TARGET_MODEL_ID) return false;
			if (turn.message.stopReason !== "toolUse" || turn.toolResults.length === 0) return false;

			const tokens = usageTokens(turn);
			if (tokens <= TOKEN_THRESHOLD) return false;
			if (agent.hasQueuedMessages()) return false;
			if (latestContext?.hasPendingMessages()) return false;

			phase = "stopped";
			stoppedTokens = tokens;
			nativeCompacted = false;
			notify(`Sol guard stopped at ${formatTokens(tokens)} tokens; compacting at idle`, "warning");
			return true;
		},
		onNativeHookDetected() {
			if (nativeHookDetected) return;
			nativeHookDetected = true;
			resetCycle();
			if (latestContext) setStatus(latestContext, "Sol guard: native hook");
			notify("Sol guard disabled because Pi already provides shouldStopAfterTurn", "info");
		},
		reportShimError(error) {
			lastError = error instanceof Error ? error.message : String(error);
			resetCycle();
			notify(`Sol guard error: ${lastError}`, "error");
		},
	};

	const patch = installPatch();

	const registerController = (ctx: ExtensionContext): boolean => {
		const host = getPatchHost();
		if (!host) return false;
		const sessionId = ctx.sessionManager.getSessionId();
		if (activeSessionId && activeSessionId !== sessionId && host.controllers.get(activeSessionId) === controller) {
			host.controllers.delete(activeSessionId);
		}
		activeSessionId = sessionId;
		host.controllers.set(sessionId, controller);
		return true;
	};

	const unregisterController = () => {
		const host = getPatchHost();
		if (activeSessionId && host?.controllers.get(activeSessionId) === controller) {
			host.controllers.delete(activeSessionId);
		}
		activeSessionId = undefined;
	};

	const continueAfterCompaction = (ctx: ExtensionContext) => {
		const host = getPatchHost();
		if (!activeSessionId || host?.controllers.get(activeSessionId) !== controller) return;
		resetCycle();
		continuationCount++;
		pi.sendMessage(
			{
				customType: EXTENSION_ID,
				content: CONTINUATION_MESSAGE,
				display: false,
				details: { threshold: TOKEN_THRESHOLD, continuation: continuationCount },
			},
			{ triggerTurn: true },
		);
		setStatus(ctx, `Sol guard 250k · resumed ${continuationCount}`);
	};

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		resetCycle();
		lastError = undefined;
		if (patch.active && registerController(ctx)) {
			setStatus(ctx, "Sol guard 250k");
		} else {
			setStatus(ctx, "Sol guard disabled");
			ctx.ui.notify(`Sol guard disabled: ${patch.reason ?? "controller registration failed"}`, "error");
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		latestContext = ctx;
	});

	pi.on("agent_start", (_event, ctx) => {
		latestContext = ctx;
		if (patch.active) registerController(ctx);
		if (phase === "stopped") resetCycle();
	});

	pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
		latestContext = ctx;
		if (phase === "stopped" && event.reason !== "manual") nativeCompacted = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		latestContext = ctx;
		if (!patch.active || phase !== "stopped") return;

		if (nativeCompacted) {
			continueAfterCompaction(ctx);
			return;
		}

		phase = "compacting";
		setStatus(ctx, `Sol guard compacting · ${formatTokens(stoppedTokens)}`);
		// Use Pi's normal compaction preparation, summarizer, and session rebuild path.
		ctx.compact({
			onComplete: () => {
				if (phase !== "compacting") return;
				continueAfterCompaction(ctx);
			},
			onError: (error) => {
				if (phase !== "compacting") return;
				lastError = error.message;
				resetCycle();
				setStatus(ctx, "Sol guard stopped: compact failed");
				ctx.ui.notify(`Sol guard stopped: compaction failed — ${error.message}`, "error");
			},
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setStatus(ctx, undefined);
		unregisterController();
		latestContext = undefined;
		resetCycle();
	});

	pi.registerCommand("sol-guard-status", {
		description: "Show Sol mid-turn context guard status",
		handler: async (_args, ctx) => {
			const status = patch.active
				? nativeHookDetected
					? "native hook detected; shim is idle"
					: `active, phase=${phase}, threshold=${formatTokens(TOKEN_THRESHOLD)}, continuations=${continuationCount}`
				: `disabled: ${patch.reason}`;
			ctx.ui.notify(lastError ? `${status}; last error=${lastError}` : status, patch.active ? "info" : "error");
		},
	});
}
