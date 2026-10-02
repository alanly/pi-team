import { describe, expect, it, vi } from "vitest";
import { spawnTeamMate, TeamMateProcess, TeamSpawnError, type SpawnTeamMateDeps } from "../src/process.ts";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FakeClient } from "./fakes.ts";

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

	it("stops the child and removes the entry when the first prompt is handled", async () => {
		const client = new FakeClient();
		client.promptDisposition = "handled";
		const deps = spawnDeps(client);
		await expect(spawnTeamMate(deps, { name: "beta", task: "x", cwd: "/work" })).rejects.toBeInstanceOf(TeamSpawnError);
		expect(client.stopped).toBe(true);
		expect(deps.removePersona).toHaveBeenCalled();
	});
});
