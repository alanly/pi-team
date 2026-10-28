import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawnTeamMate, TeamMateProcess, TeamSpawnError, type SpawnTeamMateDeps } from "../src/process.ts";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { assistantMessage, deferred, FakeClient } from "./fakes.ts";

afterEach(() => vi.useRealTimers());

async function flushPromises() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function report(client: FakeClient) {
	client.emit({ type: "tool_execution_start", toolName: "report_result", args: { status: "success", summary: "done" } });
}

function finish(client: FakeClient) {
	report(client);
	client.emit({ type: "agent_settled" });
}

function makeProcess(client: FakeClient, onComplete = vi.fn(), onChange = vi.fn()) {
	const mate = new TeamMateProcess({ name: "alpha", task: "initial task", client, onComplete, onChange });
	return { mate, onComplete, onChange };
}

describe("TeamMateProcess state machine", () => {
	it("starts in the starting state and moves to running on agent_start", () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		expect(mate.state).toBe("starting");
		client.emit({ type: "agent_start" });
		expect(mate.state).toBe("running");
	});

	it("captures a report_result deliverable and becomes idle", () => {
		const client = new FakeClient();
		const { mate, onComplete } = makeProcess(client);
		client.emit({ type: "agent_start" });
		client.emit({
			type: "tool_execution_start",
			toolName: "report_result",
			args: { status: "success", summary: "all done", data: { count: 3 }, artifacts: ["/out/a.txt"] },
		});
		client.emit({ type: "agent_end", willRetry: false });
		client.emit({ type: "agent_settled" });
		expect(mate.state).toBe("idle");
		expect(mate.result()).toMatchObject({
			reported: true,
			status: "success",
			summary: "all done",
			data: { count: 3 },
			artifacts: ["/out/a.txt"],
		});
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("uses the last assistant text when no report_result arrives", async () => {
		const client = new FakeClient();
		client.lastText = "I finished the work.";
		const { mate, onComplete } = makeProcess(client);
		client.emit({ type: "agent_start" });
		client.emit({ type: "agent_settled" });
		await vi.waitFor(() => expect(mate.state).toBe("idle"));
		expect(mate.result()).toMatchObject({ reported: false, text: "I finished the work." });
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("keeps running when agent_end carries willRetry", () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "agent_start" });
		client.emit({ type: "agent_end", willRetry: true });
		expect(mate.state).toBe("running");
		expect(mate.turns).toBe(1);
	});

	it("tracks queued inputs and waits for an empty queue", async () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "agent_start" });
		client.emit({ type: "queue_update", steering: [], followUp: ["second task"] });
		expect(mate.queuedInputs).toBe(1);
		client.emit({ type: "agent_settled" });
		expect(mate.state).toBe("running");
		client.emit({ type: "queue_update", steering: [], followUp: [] });
		client.emit({ type: "agent_settled" });
		await vi.waitFor(() => expect(mate.state).toBe("idle"));
	});

	it("tracks the current tool and the activity ring", () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
		expect(mate.currentTool).toBe("bash");
		expect(mate.getActivity()).toHaveLength(1);
		client.emit({ type: "tool_execution_end", toolName: "bash", result: "ok" });
		expect(mate.currentTool).toBeUndefined();
		expect(mate.getActivity()).toHaveLength(2);
	});

	it("caps the activity ring at 10 events", () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		for (let i = 0; i < 15; i++) client.emit({ type: "message_end", message: { content: `m${i}` } });
		expect(mate.getActivity()).toHaveLength(10);
		expect(mate.getActivity()[9]?.preview).toBe("m14");
	});

	it("moves to idle synchronously when the deliverable already exists", () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "tool_execution_start", toolName: "report_result", args: { status: "blocked", summary: "needs input" } });
		client.emit({ type: "agent_settled" });
		expect(mate.state).toBe("idle");
		expect(mate.result()?.status).toBe("blocked");
	});
});

describe("TeamMateProcess cost accounting", () => {
	it("stores zero in new snapshots and restores frozen costs at full precision", () => {
		const { mate } = makeProcess(new FakeClient());
		expect(mate.cost).toBe(0);
		expect(mate.snapshotEntry().cost).toBe(0);
		const stub = TeamMateProcess.frozenStub({ name: "old", task: "old task", state: "idle", cost: 0.13812345 });
		expect(stub.cost).toBe(0.13812345);
		expect(stub.snapshotEntry().cost).toBe(0.13812345);
		expect(TeamMateProcess.frozenStub({ name: "legacy", task: "t", state: "idle" }).cost).toBe(0);
	});

	it("counts finalized assistant responses only, without response-ID or timestamp deduplication", () => {
		const client = new FakeClient();
		const { mate, onChange } = makeProcess(client);
		const message = { ...assistantMessage(0.1), responseId: "same-id" };
		client.emit({ type: "message_update", usage: { input: 10, output: 5, cost: { total: 5 } } });
		expect(mate.cost).toBe(0);
		client.emit({ type: "message_end", message });
		expect(mate.cost).toBe(0.1);
		expect(onChange).toHaveBeenCalled();
		client.emit({ type: "turn_end", message });
		client.emit({ type: "agent_end", messages: [message] });
		client.emit({ type: "tool_execution_end", toolName: "bash", result: { usage: message.usage } });
		for (const role of ["user", "toolResult", "custom"]) client.emit({ type: "message_end", message: { ...message, role } });
		expect(mate.cost).toBe(0.1);
		client.emit({ type: "message_end", message });
		expect(mate.cost).toBe(0.2);
	});

	it.each([
		undefined, null, {}, { role: "assistant" }, { role: "assistant", usage: null },
		{ role: "assistant", usage: { cost: null } },
		...[undefined, null, "0.1", -1, NaN, Infinity, -Infinity].map((total) => ({ role: "assistant", usage: { cost: { total } } })),
	])("ignores malformed finalized costs: %j", (message) => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		client.emit({ type: "message_end", message });
		expect(mate.cost).toBe(0.1);
		client.emit({ type: "message_end", message: assistantMessage(0) });
		expect(mate.cost).toBe(0.1);
	});

	it("retains overhead across follow-ups, repeated statistics, and lower cumulative values", async () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		client.statsResult = { cost: 0.13 };
		finish(client);
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.13);
		await mate.startTask("follow-up");
		finish(client);
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.13);
		await mate.startTask("another task");
		client.emit({ type: "message_end", message: assistantMessage(0.025) });
		expect(mate.cost).toBeCloseTo(0.155);
		client.statsResult = { cost: 0.16 };
		finish(client);
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.16);
		await mate.startTask("last task");
		client.statsResult = { cost: 0.01 };
		finish(client);
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.16);
		expect(client.statsCalls).toBe(4);
	});

	it("settles synchronously and notifies once while accounting remains unresolved", async () => {
		const client = new FakeClient();
		const stats = deferred<unknown>();
		client.statsResponse = stats.promise;
		const { mate, onComplete, onChange } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		finish(client);
		expect(mate.state).toBe("idle");
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(client.statsCalls).toBe(1);
		client.emit({ type: "agent_settled" });
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(client.statsCalls).toBe(1);
		onChange.mockClear();
		stats.resolve({ cost: 0.13 });
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.13);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("rejects stale stats even if a complete new response settles during their round trip", async () => {
		const client = new FakeClient();
		const oldStats = deferred<unknown>();
		const getStats = vi.spyOn(client, "getSessionStats").mockReturnValueOnce(oldStats.promise).mockResolvedValue({ cost: 0.125 });
		const { mate } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		finish(client);
		await mate.startTask("follow-up");
		client.emit({ type: "message_end", message: assistantMessage(0.025) });
		finish(client);
		await flushPromises();
		oldStats.resolve({ cost: 0.125 });
		await flushPromises();
		expect(mate.state).toBe("idle");
		expect(getStats).toHaveBeenCalledTimes(2);
		expect(mate.cost).toBeCloseTo(0.125);
	});

	it.each([0, undefined])("invalidates the epoch for an assistant response with cost %s", async (cost) => {
		const client = new FakeClient();
		const stats = deferred<unknown>();
		client.statsResponse = stats.promise;
		const { mate } = makeProcess(client);
		finish(client);
		await mate.startTask("follow-up");
		client.emit({ type: "message_end", message: { role: "assistant", usage: { cost: { total: cost } } } });
		stats.resolve({ cost: 0.2 });
		await flushPromises();
		expect(mate.cost).toBe(0);
	});

	it("does not invalidate safe statistics just because a new prompt starts", async () => {
		const client = new FakeClient();
		const stats = deferred<unknown>();
		client.statsResponse = stats.promise;
		const { mate } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		finish(client);
		await mate.startTask("follow-up");
		stats.resolve({ cost: 0.13 });
		await flushPromises();
		expect(mate.state).toBe("running");
		expect(mate.cost).toBeCloseTo(0.13);
	});

	it("takes the maximum offset from concurrent eligible statistics without extra change callbacks", async () => {
		const client = new FakeClient();
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		vi.spyOn(client, "getSessionStats").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { mate, onChange } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		finish(client);
		await mate.startTask("follow-up");
		finish(client);
		onChange.mockClear();
		second.resolve({ cost: 0.15 });
		await flushPromises();
		first.resolve({ cost: 0.13 });
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.15);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, null, {}, { cost: "1" }, { cost: -1 }, { cost: NaN }, { cost: Infinity }])("ignores malformed statistics: %j", async (stats) => {
		const client = new FakeClient();
		client.statsResult = stats;
		const { mate, onChange, onComplete } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		finish(client);
		onChange.mockClear();
		await flushPromises();
		expect(mate.cost).toBe(0.1);
		expect(onChange).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("limits settlement accounting to one second and ignores its late response", async () => {
		vi.useFakeTimers();
		const client = new FakeClient();
		const stats = deferred<unknown>();
		client.statsResponse = stats.promise;
		const { mate, onComplete, onChange } = makeProcess(client);
		finish(client);
		expect(mate.state).toBe("idle");
		expect(onComplete).toHaveBeenCalledTimes(1);
		onChange.mockClear();
		await vi.advanceTimersByTimeAsync(1000);
		expect(vi.getTimerCount()).toBe(0);
		stats.resolve({ cost: 3 });
		await flushPromises();
		expect(mate.cost).toBe(0);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not let rejected statistics delay or repeat completion", async () => {
		const client = new FakeClient();
		const stats = deferred<unknown>();
		client.statsResponse = stats.promise;
		const { mate, onComplete } = makeProcess(client);
		finish(client);
		stats.reject(new Error("stats unavailable"));
		await flushPromises();
		expect(mate.state).toBe("idle");
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(mate.cost).toBe(0);
	});

	it("only requests accounting for eligible settlements, not queued work or observational reads", async () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "queue_update", followUp: ["next"] });
		client.emit({ type: "agent_settled" });
		expect(client.statsCalls).toBe(0);
		expect(mate.state).toBe("running");
		client.statsResult = { cost: 4 };
		expect(await mate.liveStats()).toEqual({ cost: 4 });
		expect(mate.cost).toBe(0);
	});
});

describe("TeamMateProcess finalization", () => {
	it.each(["running", "idle"] as const)("closes a %s teammate before final statistics and shares one stop operation", async (state) => {
		const client = new FakeClient();
		const stats = deferred<unknown>();
		const stopped = deferred<void>();
		client.statsResponse = stats.promise;
		client.stopResponse = stopped.promise;
		const { mate, onChange, onComplete } = makeProcess(client);
		mate.state = state;
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		const before = mate.snapshotEntry();
		onChange.mockClear();
		const stop = mate.stop();
		expect(mate.closed).toBe(true);
		expect(mate.stop()).toBe(stop);
		expect(client.callOrder).toEqual(["unsubscribe", "stats"]);
		expect(client.listeners.size).toBe(0);
		client.emit({ type: "message_end", message: assistantMessage(0.025) });
		mate.handleEvent({ type: "message_end", message: assistantMessage(0.025) });
		mate.handleEvent({ type: "agent_start" });
		mate.handleEvent({ type: "agent_settled" });
		stats.resolve({ cost: 0.16 });
		await flushPromises();
		expect(client.callOrder).toEqual(["unsubscribe", "stats", "stop"]);
		expect(mate.cost).toBeCloseTo(0.16);
		expect(mate.snapshotEntry()).toEqual({ ...before, cost: mate.cost });
		expect(onChange).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
		stopped.resolve();
		await stop;
		await mate.stop();
		expect(client.stopCalls).toBe(1);
		expect(client.statsCalls).toBe(1);
	});

	it("retains known overhead when final statistics are lower", async () => {
		const client = new FakeClient();
		const { mate } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		client.statsResult = { cost: 0.13 };
		finish(client);
		await flushPromises();
		client.statsResult = { cost: 0.11 };
		await mate.stop();
		expect(mate.cost).toBeCloseTo(0.13);
	});

	it("times out final statistics at one second, still bounds stop, and ignores late responses", async () => {
		vi.useFakeTimers();
		const client = new FakeClient();
		const stats = deferred<unknown>();
		const stopped = deferred<void>();
		client.statsResponse = stats.promise;
		client.stopResponse = stopped.promise;
		const { mate, onChange } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		onChange.mockClear();
		const stop = mate.stop();
		await vi.advanceTimersByTimeAsync(999);
		expect(client.stopCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.stopCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(5000);
		await stop;
		stats.resolve({ cost: 3 });
		stopped.reject(new Error("late stop rejection"));
		await flushPromises();
		expect(mate.cost).toBe(0.1);
		expect(onChange).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("still stops after final stats reject and shares failures with explicit cleanup", async () => {
		const client = new FakeClient();
		const stats = deferred<unknown>();
		client.statsResponse = stats.promise;
		const { mate } = makeProcess(client);
		const stop = mate.stop();
		stats.reject(new Error("unavailable"));
		await stop;
		expect(client.stopped).toBe(true);
		expect(client.stopCalls).toBe(1);
	});

	it("routes failure through memoized stop without final statistics", async () => {
		const client = new FakeClient();
		const { mate, onChange } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		onChange.mockClear();
		mate.markFailed("gone");
		expect(mate.closed).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);
		await mate.stop();
		mate.markFailed("again");
		expect(client.callOrder).toEqual(["unsubscribe", "stop"]);
		expect(client.statsCalls).toBe(0);
		expect(client.stopCalls).toBe(1);
		expect(mate.cost).toBe(0.1);
	});

	it("preserves frozen costs when stopped", async () => {
		const mate = TeamMateProcess.frozenStub({ name: "old", task: "t", state: "idle", cost: 0.13 });
		await mate.stop();
		expect(mate.closed).toBe(true);
		expect(mate.cost).toBe(0.13);
	});

	it("discards ordinary statistics after closing, including responses later than final statistics", async () => {
		const client = new FakeClient();
		const ordinary = deferred<unknown>();
		vi.spyOn(client, "getSessionStats").mockReturnValueOnce(ordinary.promise).mockResolvedValue({ cost: 0.13 });
		const { mate, onChange, onComplete } = makeProcess(client);
		client.emit({ type: "message_end", message: assistantMessage(0.1) });
		finish(client);
		onChange.mockClear();
		await mate.stop();
		ordinary.resolve({ cost: 8 });
		await flushPromises();
		expect(mate.cost).toBeCloseTo(0.13);
		expect(onChange).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("never completes or revives a closed teammate from late fallback text", async () => {
		const client = new FakeClient();
		const fallback = deferred<string | null>();
		client.lastTextResponse = fallback.promise;
		const { mate, onChange, onComplete } = makeProcess(client);
		client.emit({ type: "agent_start" });
		client.emit({ type: "agent_settled" });
		await mate.stop();
		onChange.mockClear();
		fallback.resolve("too late");
		await flushPromises();
		expect(mate.state).toBe("running");
		expect(mate.result()).toBeUndefined();
		expect(onChange).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it.each(["initialPrompt", "startTask", "steer", "queue"] as const)("rejects late %s replies and new commands after close without changing state", async (command) => {
		const client = new FakeClient();
		const prompt = deferred<"started">();
		const queued = deferred<"queued">();
		client.promptResponse = prompt.promise;
		client.steerResponse = queued.promise;
		client.followUpResponse = queued.promise;
		const { mate, onChange, onComplete } = makeProcess(client);
		mate.state = "idle";
		const pending = mate[command]("new task");
		const rejected = expect(pending).rejects.toThrow(/closed/i);
		await mate.stop();
		onChange.mockClear();
		prompt.resolve("started");
		queued.resolve("queued");
		await rejected;
		expect(mate.state).toBe("idle");
		expect(onChange).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
		await expect(mate[command]("ignored")).rejects.toThrow(/closed/i);
		expect(client.promptCalls.length + client.steerCalls.length + client.followUpCalls.length).toBe(1);
	});

	it.each(["resolve", "reject"] as const)("ignores probe %s continuations after stop", async (outcome) => {
		const client = new FakeClient();
		const state = deferred<unknown>();
		client.stateResponse = state.promise;
		const { mate, onChange } = makeProcess(client);
		const probe = mate.probe();
		await mate.stop();
		onChange.mockClear();
		if (outcome === "reject") state.reject(new Error("Agent process exited (code=1 signal=null)."));
		else state.resolve({});
		expect(await probe).toBe("alive");
		expect(mate.state).toBe("starting");
		expect(mate.failureNote).toBeUndefined();
		expect(onChange).not.toHaveBeenCalled();
		expect(client.stopCalls).toBe(1);
	});
});

describe("TeamMateProcess probes", () => {
	it("sets failed on the first process exit error and stops the client", async () => {
		const client = new FakeClient();
		client.stateError = new Error("Agent process exited (code=1 signal=null). Stderr: ");
		const { mate } = makeProcess(client);
		expect(await mate.probe()).toBe("failed");
		expect(mate.state).toBe("failed");
		expect(client.stopped).toBe(true);
		expect(mate.failureNote).toContain("Agent process exited");
	});

	it("needs two consecutive other failures", async () => {
		const client = new FakeClient();
		client.stateError = new Error("socket hang up");
		const { mate } = makeProcess(client);
		expect(await mate.probe()).toBe("alive");
		// A successful probe resets the failure count and does not change the state.
		expect(mate.state).toBe("starting");
		expect(await mate.probe()).toBe("failed");
		expect(mate.state).toBe("failed");
	});

	it("resets the failure count on a success", async () => {
		const client = new FakeClient();
		client.stateError = new Error("socket hang up");
		const { mate } = makeProcess(client);
		expect(await mate.probe()).toBe("alive");
		client.stateError = undefined;
		expect(await mate.probe()).toBe("alive");
		client.stateError = new Error("socket hang up");
		expect(await mate.probe()).toBe("alive");
	});

	it("ignores later events after the failed state", async () => {
		const client = new FakeClient();
		client.stateError = new Error("Agent process exited (code=1 signal=null).");
		const { mate } = makeProcess(client);
		await mate.probe();
		client.emit({ type: "agent_start" });
		expect(mate.state).toBe("failed");
	});
});

describe("TeamMateProcess frozen stubs", () => {
	it("marks a restored running entry as failed with the note", () => {
		const stub = TeamMateProcess.frozenStub({ name: "ghost", state: "running", task: "old task" }, "parent session reloaded");
		expect(stub.frozen).toBe(true);
		expect(stub.state).toBe("failed");
		expect(stub.failureNote).toBe("parent session reloaded");
	});

	it("keeps the deliverable of an idle stub", () => {
		const deliverable = { reported: true as const, status: "success" as const, summary: "done", capturedAt: 5 };
		const stub = TeamMateProcess.frozenStub({ name: "ghost", state: "idle", task: "old task", deliverable });
		expect(stub.state).toBe("idle");
		expect(stub.result()).toEqual(deliverable);
	});

	it("probes alive and stops without a client", async () => {
		const stub = TeamMateProcess.frozenStub({ name: "ghost", state: "running", task: "old task" });
		expect(await stub.probe()).toBe("alive");
		await expect(stub.stop()).resolves.toBeUndefined();
	});
});

describe("spawnTeamMate", () => {
	function spawnDeps(client: FakeClient, seen: RpcClientOptions[] = []): SpawnTeamMateDeps {
		return {
			createClient: (options) => {
				seen.push(options);
				return client;
			},
			writePersona: vi.fn(async () => "/tmp/persona/system-prompt.md"),
			removePersona: vi.fn(async () => undefined),
			resolveCliPath: () => "/pi/dist/cli.js",
			resolveChildExtensions: () => ["/ext/ollama.ts"],
			reportResultPath: "/repo/src/report-result.ts",
			config: DEFAULT_CONFIG,
			onChange: vi.fn(),
			onComplete: vi.fn(),
		};
	}

	it("starts the client and sends the first prompt", async () => {
		const client = new FakeClient();
		const seen: RpcClientOptions[] = [];
		const deps = spawnDeps(client, seen);
		const mate = await spawnTeamMate(deps, { name: "beta", task: "audit the code", cwd: "/work" });
		expect(client.started).toBe(true);
		expect(client.promptCalls).toEqual(["audit the code"]);
		expect(mate.state).toBe("starting");
		expect(seen[0]?.cliPath).toBe("/pi/dist/cli.js");
		expect(seen[0]?.cwd).toBe("/work");
		expect(seen[0]?.env).toEqual({ PI_TEAMMATE: "1" });
		expect(seen[0]?.args).toContain("/ext/ollama.ts");
	});

	it("removes the registry entry when the child fails at startup", async () => {
		const client = new FakeClient();
		client.startError = new Error("unknown model");
		const deps = spawnDeps(client);
		await expect(spawnTeamMate(deps, { name: "beta", task: "x", cwd: "/work" })).rejects.toBeInstanceOf(TeamSpawnError);
		expect(deps.removePersona).toHaveBeenCalledWith("/tmp/persona/system-prompt.md");
	});

	describe("provided extensions", () => {
		const dirs: string[] = [];
		async function tempDir(): Promise<string> {
			const dir = await mkdtemp(join(tmpdir(), "pi-team-spawn-"));
			dirs.push(dir);
			return dir;
		}
		afterAll(async () => {
			await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
		});

		async function writeExtension(dir: string, name: string): Promise<string> {
			const extPath = join(dir, name);
			await writeFile(extPath, "export default () => {}\n");
			return extPath;
		}

		it("merges the provided extensions with the resolved defaults", async () => {
			const dir = await tempDir();
			const extPath = await writeExtension(dir, "search.ts");
			const client = new FakeClient();
			const seen: RpcClientOptions[] = [];
			const deps = spawnDeps(client, seen);
			await spawnTeamMate(deps, { name: "beta", task: "x", cwd: dir, extensions: [extPath] });
			const args = seen[0]?.args ?? [];
			expect(args).toContain("/ext/ollama.ts");
			expect(args).toContain(extPath);
			expect(args.indexOf("/ext/ollama.ts")).toBeLessThan(args.indexOf(extPath));
		});

		it("does not duplicate an extension the defaults already resolve", async () => {
			const dir = await tempDir();
			const extPath = await writeExtension(dir, "shared.ts");
			const client = new FakeClient();
			const seen: RpcClientOptions[] = [];
			const deps = { ...spawnDeps(client, seen), resolveChildExtensions: () => [extPath] };
			await spawnTeamMate(deps, { name: "beta", task: "x", cwd: dir, extensions: [extPath] });
			expect((seen[0]?.args ?? []).filter((arg) => arg === extPath)).toHaveLength(1);
		});

		it("resolves a relative path against the cwd", async () => {
			const dir = await tempDir();
			await writeExtension(dir, "search.ts");
			const client = new FakeClient();
			const seen: RpcClientOptions[] = [];
			const deps = spawnDeps(client, seen);
			await spawnTeamMate(deps, { name: "beta", task: "x", cwd: dir, extensions: ["./search.ts"] });
			expect(seen[0]?.args).toContain(join(dir, "search.ts"));
		});

		it("passes builtin: paths through without a disk check", async () => {
			const client = new FakeClient();
			const seen: RpcClientOptions[] = [];
			const deps = spawnDeps(client, seen);
			await spawnTeamMate(deps, { name: "beta", task: "x", cwd: "/work", extensions: ["builtin:mcp"] });
			expect(seen[0]?.args).toContain("builtin:mcp");
		});

		it("fails the spawn with the missing paths when a file does not exist", async () => {
			const dir = await tempDir();
			const client = new FakeClient();
			const deps = spawnDeps(client);
			const badSpawn = spawnTeamMate(deps, {
				name: "beta",
				task: "x",
				cwd: dir,
				extensions: [join(dir, "missing.ts")],
			});
			await expect(badSpawn).rejects.toBeInstanceOf(TeamSpawnError);
			await expect(badSpawn).rejects.toThrowError(/missing\.ts/);
			expect(client.started).toBe(false);
		});
	});

	it("stops the child and removes the entry when the first prompt is handled", async () => {
		const client = new FakeClient();
		client.promptDisposition = "handled";
		const deps = spawnDeps(client);
		await expect(spawnTeamMate(deps, { name: "beta", task: "x", cwd: "/work" })).rejects.toBeInstanceOf(TeamSpawnError);
		expect(client.stopped).toBe(true);
		expect(deps.removePersona).toHaveBeenCalled();
	});
});
