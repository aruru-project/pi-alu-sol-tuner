import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent, type AgentLoopConfig, type ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "alu-sol-tuner";
const STATUS_KEY = EXTENSION_ID;
const TARGET_MODEL_ID = "gpt-5.6-sol";
const DEFAULT_GUARD_THRESHOLD = 250_000;
const PATCH_KEY = Symbol.for("pi.sol-mid-turn-guard.patch.v2");
const LEGACY_PATCH_KEY = Symbol.for("pi.sol-mid-turn-guard.patch.v1");
const MARKER = "GPT-5.6 Sol";

const FLOOR = `

## 全局工程底线（机器级注入；项目明文规则在其领域内优先）

改动：同一能力、常量、协议形状只保留一个定义点，发现重复定义、逐方法转发、兼容壳、双轨实现先停下报告，不照着扩展。无调用方的代码、只写不读的状态、为假想场景准备的兼容分支发现即删或报告，不模仿。附近代码不是先例，模仿前先对照项目规则文档。用户可见文案不出现内部机制词、类名、UUID、裸枚举值；每条错误说清发生了什么、用户现在能做什么。

验证：同一事实一份证据，换命令重证已确认的事实是浪费。升级到全量测试/构建每任务至多一次，且仅当改动确实跨模块。

测试：默认配额为一条产品能力一个走真实入口的端到端测试，加上有明确输入输出的模块测试，超出要有具体理由。否定式断言（bounded/rejects/never/closed）必须有出处：真实事故、安全边界、或被外部依赖的冻结协议，没有出处不写。fixture/fake 不得用被测系统的常量或算法计算断言期望值；复用生产库"说协议"可以，用被测逻辑"算答案"是自证。不断言 Mock 调用序列、内部调用次数、内部错误措辞，不为"理论上可能"写防御测试。测试标题说出用户动作和可见结果。

规则按本意执行：引用规则指控或模仿例外前，先回答"它防的是什么事故"，答不上来就不引用。`;

const SOL = `

## GPT-5.6 Sol 专项纪律（按模型注入）

你（GPT-5.6 Sol）的已知偏差：把可见努力当质量、把"充分验证"扩大为无界探索、规则字面化。约束：

- One fact, one proof：通过的检查不重跑；换一条命令、换个措辞再证明同一事实也是重复验证，禁止。
- 数字锚：定位与阅读约 10 次工具调用内、验证约 5 条命令内完成；超出说明范围已漂移，收敛而不是加倍努力。
- 已有充分证据的结论不做第二遍复审。没找到缺陷时，"干净"是合法结果，不为找问题而继续搜索。
- 每个行为变化至多一条测试证明，优先修改既有断言；不新增防御性测试护栏，不把测试数量当完成证明。
- 触发上下文压缩说明任务规模已超标：恢复后只收尾，不开新线。
- 引用规则指控或模仿例外前，先回答"它防的是什么事故"；字面命中但本意不符，降级为一行备注或放弃。`;

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

interface AluSolConfig {
	disabled: Set<string>;
	guardThreshold: number;
}

function readConfig(startDir: string): AluSolConfig {
	let dir = startDir;
	for (let depth = 0; depth < 64; depth += 1) {
		const file = join(dir, ".pi", "alu-sol.json");
		if (existsSync(file)) {
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as {
					disable?: unknown;
					guardThreshold?: unknown;
				};
				const disable = Array.isArray(parsed?.disable) ? parsed.disable : [];
				const configuredThreshold = parsed?.guardThreshold;
				const guardThreshold = typeof configuredThreshold === "number"
					&& Number.isInteger(configuredThreshold)
					&& configuredThreshold > 0
					? configuredThreshold
					: DEFAULT_GUARD_THRESHOLD;
				return {
					disabled: new Set(disable.filter((item): item is string => typeof item === "string")),
					guardThreshold,
				};
			} catch {
				return { disabled: new Set(), guardThreshold: DEFAULT_GUARD_THRESHOLD };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { disabled: new Set(), guardThreshold: DEFAULT_GUARD_THRESHOLD };
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
			return { active: false, reason: "当前 Pi 版本不支持此保护；请更新插件或 Pi" };
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
		return { active: false, reason: "检测到其他上下文保护；请避免同时加载同类插件" };
	}

	return { active: true };
}

export default function aluSolTuner(pi: ExtensionAPI): void {
	const generation = Symbol("alu-sol-tuner-generation");
	let phase: GuardPhase = "idle";
	let latestContext: ExtensionContext | undefined;
	let stoppedTokens = 0;
	let nativeCompacted = false;
	let nativeHookDetected = false;
	let continuationCount = 0;
	let lastError: string | undefined;
	let activeSessionId: string | undefined;
	let guardThreshold = DEFAULT_GUARD_THRESHOLD;

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
			if (tokens <= guardThreshold) return false;
			if (agent.hasQueuedMessages()) return false;
			if (latestContext?.hasPendingMessages()) return false;

			phase = "stopped";
			stoppedTokens = tokens;
			nativeCompacted = false;
			notify(`阿露 Sol 调教在 ${formatTokens(tokens)} tokens 暂停；空闲后压缩上下文`, "warning");
			return true;
		},
		onNativeHookDetected() {
			if (nativeHookDetected) return;
			nativeHookDetected = true;
			resetCycle();
			if (latestContext) setStatus(latestContext, "阿露 Sol 调教 · Pi 原生保护");
			notify("阿露 Sol 调教已让位：Pi 已提供回合后停止能力", "info");
		},
		reportShimError(error) {
			lastError = error instanceof Error ? error.message : String(error);
			resetCycle();
			notify(`阿露 Sol 调教出错：${lastError}`, "error");
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
				details: { threshold: guardThreshold, continuation: continuationCount },
			},
			{ triggerTurn: true },
		);
		setStatus(ctx, `阿露 Sol 调教 · ${formatTokens(guardThreshold)} · 已续跑 ${continuationCount}`);
	};

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		guardThreshold = readConfig(ctx.cwd).guardThreshold;
		resetCycle();
		lastError = undefined;
		if (patch.active && registerController(ctx)) {
			setStatus(ctx, `阿露 Sol 调教 · ${formatTokens(guardThreshold)}`);
		} else {
			setStatus(ctx, "阿露 Sol 调教 · 已停用");
			ctx.ui.notify(`阿露 Sol 调教已停用：${patch.reason ?? "无法注册会话保护"}`, "error");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const config = readConfig(event.systemPromptOptions?.cwd ?? ctx.cwd);
		guardThreshold = config.guardThreshold;
		const disabled = config.disabled;
		if (disabled.has("all") || disabled.has("*")) return;

		let prompt = event.systemPrompt;
		let changed = false;
		if (!disabled.has("engineering-discipline")) {
			prompt += FLOOR;
			changed = true;
		}
		const model = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
		if (!disabled.has("sol-discipline")
			&& /gpt-[\d.]+[a-z0-9-]*-sol/i.test(model)
			&& !event.systemPrompt.includes(MARKER)) {
			prompt += SOL;
			changed = true;
		}
		if (changed) return { systemPrompt: prompt };
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
		setStatus(ctx, `阿露 Sol 调教 · 正在压缩 ${formatTokens(stoppedTokens)}`);
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
				setStatus(ctx, "阿露 Sol 调教 · 压缩失败");
				ctx.ui.notify(`阿露 Sol 调教已停止：压缩失败 — ${error.message}`, "error");
			},
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setStatus(ctx, undefined);
		unregisterController();
		latestContext = undefined;
		resetCycle();
	});

	pi.registerCommand("alu-sol-status", {
		description: "查看阿露的 Sol 调教插件状态",
		handler: async (_args, ctx) => {
			const phaseText: Record<GuardPhase, string> = {
				idle: "等待触发",
				stopped: "等待压缩",
				compacting: "正在压缩",
			};
			const status = patch.active
				? nativeHookDetected
					? "阿露 Sol 调教：Pi 已提供原生保护，本插件无需接管"
					: `阿露 Sol 调教：运行中，${phaseText[phase]}，阈值=${formatTokens(guardThreshold)}，已续跑=${continuationCount}`
				: `阿露 Sol 调教：已停用，${patch.reason}`;
			ctx.ui.notify(lastError ? `${status}；最近错误=${lastError}` : status, patch.active ? "info" : "error");
		},
	});
}
