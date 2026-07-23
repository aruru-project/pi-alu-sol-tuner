import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(projectRoot, "index.ts");
const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const tempAgentDir = mkdtempSync(join(tmpdir(), "sol-guard-smoke-"));

try {
	const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")));
	const { Agent } = await import(
		pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js")),
	);

	const context = (sessionId, calls) => ({
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify() {}, setStatus() {} },
		hasPendingMessages: () => false,
		compact(options) {
			calls.compactions++;
			if (calls.compactError) options.onError?.(new Error("synthetic compact failure"));
			else options.onComplete?.({});
		},
	});
	const emit = async (extension, eventName, ctx, extra = {}) => {
		for (const handler of extension.handlers.get(eventName) ?? []) {
			await handler({ type: eventName, ...extra }, ctx);
		}
	};
	const loadRuntime = async (sessionId) => {
		const result = await loader.discoverAndLoadExtensions([extensionPath], projectRoot, tempAgentDir);
		if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
		const extension = result.extensions[0];
		const calls = { compactions: 0, compactError: false, messages: [] };
		result.runtime.sendMessage = (message, options) => calls.messages.push({ message, options });
		const ctx = context(sessionId, calls);
		await emit(extension, "session_start", ctx);
		return { extension, ctx, calls };
	};

	const message = (model, totalTokens, withTools = true) => ({
		role: "assistant",
		content: withTools ? [{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }] : [],
		api: "openai-responses",
		provider: "openai-codex",
		model,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: withTools ? "toolUse" : "stop",
		timestamp: Date.now(),
	});
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "noop",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
	const turn = (assistant, toolResults = [toolResult]) => ({
		message: assistant,
		toolResults,
		context: { systemPrompt: "", messages: [assistant, ...toolResults], tools: [] },
		newMessages: [assistant, ...toolResults],
	});

	const runtimeA = await loadRuntime("runtime-a");
	const wrapper = Agent.prototype.createLoopConfig;
	const agentA = new Agent({ sessionId: "runtime-a" });
	const configA = agentA.createLoopConfig();
	if (typeof configA.shouldStopAfterTurn !== "function") throw new Error("runtime A hook was not installed");

	// Runtime B is created later; it must not replace A's controller.
	const runtimeB = await loadRuntime("runtime-b");
	const agentB = new Agent({ sessionId: "runtime-b" });
	const configB = agentB.createLoopConfig();
	if (typeof configB.shouldStopAfterTurn !== "function") throw new Error("runtime B hook was not installed");
	if (Agent.prototype.createLoopConfig !== wrapper) throw new Error("runtime B stacked the prototype wrapper");

	if (await configB.shouldStopAfterTurn(turn(message("other-model", 300_000)))) {
		throw new Error("non-Sol model was stopped");
	}
	if (await configB.shouldStopAfterTurn(turn(message("gpt-5.6-sol", 250_000)))) {
		throw new Error("250k boundary should not stop");
	}
	if (await configB.shouldStopAfterTurn(turn(message("gpt-5.6-sol", 300_000, false), []))) {
		throw new Error("no-tool turn was stopped");
	}

	agentB.steer({ role: "user", content: "owner queued", timestamp: Date.now() });
	if (await configB.shouldStopAfterTurn(turn(message("gpt-5.6-sol", 250_001)))) {
		throw new Error("queued owner message should suppress stop");
	}
	agentB.clearAllQueues();

	if (!(await configA.shouldStopAfterTurn(turn(message("gpt-5.6-sol", 250_001))))) {
		throw new Error("runtime A lost its controller after runtime B started");
	}
	await emit(runtimeA.extension, "agent_settled", runtimeA.ctx);
	if (runtimeA.calls.compactions !== 1 || runtimeA.calls.messages.length !== 1) {
		throw new Error("runtime A did not compact and resume through its own runtime");
	}

	if (!(await configB.shouldStopAfterTurn(turn(message("gpt-5.6-sol", 250_001))))) {
		throw new Error("runtime B did not stop independently");
	}
	runtimeB.calls.compactError = true;
	await emit(runtimeB.extension, "agent_settled", runtimeB.ctx);
	if (runtimeB.calls.compactions !== 1 || runtimeB.calls.messages.length !== 0) {
		throw new Error("runtime B compaction error did not stop without continuation");
	}

	// Replacement registers first; stale shutdown from the old B must not delete it.
	const replacementB = await loadRuntime("runtime-b");
	await emit(runtimeB.extension, "session_shutdown", runtimeB.ctx, { reason: "reload" });
	const replacementAgentB = new Agent({ sessionId: "runtime-b" });
	const replacementConfigB = replacementAgentB.createLoopConfig();
	if (!(await replacementConfigB.shouldStopAfterTurn(turn(message("gpt-5.6-sol", 250_001))))) {
		throw new Error("stale runtime B cleanup removed its replacement controller");
	}
	if (Agent.prototype.createLoopConfig !== wrapper) throw new Error("reload stacked or replaced the wrapper");

	await emit(runtimeA.extension, "session_shutdown", runtimeA.ctx, { reason: "shutdown" });
	await emit(replacementB.extension, "session_shutdown", replacementB.ctx, { reason: "shutdown" });

	console.log(
		"smoke ok: dual-runtime routing, independent stop/compact/resume, compact error, stale cleanup, reload idempotence",
	);
} finally {
	rmSync(tempAgentDir, { recursive: true, force: true });
}
