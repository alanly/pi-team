import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ParentActivity, TeamNotify } from "../src/notify.ts";
import { TeamMateProcess } from "../src/process.ts";
import { TeamRegistry } from "../src/registry.ts";
import { StatusLine } from "../src/statusline.ts";
import { TeamTools } from "../src/tools.ts";
import type { PiTeamConfig } from "../src/types.ts";
import { FakeClient, mockContext, mockPi } from "./fakes.ts";

const tempDirs: string[] = [];
async function writeExtensionFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-team-tools-"));
	tempDirs.push(dir);
	const extPath = join(dir, "helper.ts");
	await writeFile(extPath, "export default () => {}\n");
	return extPath;
}
afterAll(async () => {
	await Promise.allSettled(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(client: FakeClient = new FakeClient(), config: PiTeamConfig = { ...DEFAULT_CONFIG, maxTeammates: 2 }) {
	const { pi, calls } = mockPi();
	const registry = new TeamRegistry(pi);
	const statusline = new StatusLine(registry);
	const activity = new ParentActivity();
	const notify = new TeamNotify({ pi, registry, activity });
	const seen: RpcClientOptions[] = [];
	const onRegistryChange = vi.fn();
	const tools = new TeamTools({
		pi,
		registry,
		statusline,
		notify,
		getConfig: () => config,
		createClient: (options) => {
			seen.push(options);
			return client;
		},
		writePersona: vi.fn(async () => "/tmp/persona/system-prompt.md"),
		removePersona: vi.fn(async () => undefined),
		resolveCliPath: () => "/pi/dist/cli.js",
		resolveChildExtensions: () => [],
		reportResultPath: "/repo/src/report-result.ts",
		onRegistryChange,
	});
	const { ctx, statuses } = mockContext();
	registry.captureContext(ctx);
	return { tools, registry, pi, calls, ctx, statuses, client, seen, config, onRegistryChange };
}

describe("team_spawn", () => {
	it("adds a teammate and returns immediately", async () => {
		const { tools, registry, client, seen, ctx, onRegistryChange } = setup();
		const result = await tools.spawn({ task: "audit the code" }, ctx);
		expect(result.isError).toBeFalsy();
		expect(registry.size).toBe(1);
		expect(registry.get("teammate-1")?.state).toBe("starting");
		expect(client.promptCalls).toEqual(["audit the code"]);
		expect(seen[0]?.cliPath).toBe("/pi/dist/cli.js");
		// The health probe timer shall start when the first teammate exists.
		expect(onRegistryChange).toHaveBeenCalled();
	});

	it("rejects a duplicate name", async () => {
		const { tools, registry, ctx } = setup();
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "running" }));
		const result = await tools.spawn({ task: "x", name: "alpha" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("already exists");
	});

	it("enforces maxTeammates", async () => {
		const { tools, registry, ctx } = setup();
		registry.add(new TeamMateProcess({ name: "a", task: "t", state: "running" }));
		registry.add(new TeamMateProcess({ name: "b", task: "t", state: "running" }));
		const result = await tools.spawn({ task: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("limit (2)");
	});

	it("passes the extensions list to the child", async () => {
		const extPath = await writeExtensionFile();
		const { tools, registry, seen, ctx } = setup();
		const result = await tools.spawn({ task: "x", extensions: [extPath] }, ctx);
		expect(result.isError).toBeFalsy();
		expect(registry.size).toBe(1);
		expect(seen[0]?.args).toContain(extPath);
	});

	it("returns an error and adds no teammate when an extension path does not exist", async () => {
		const { tools, registry, ctx } = setup();
		const result = await tools.spawn({ task: "x", extensions: ["/no/such/missing.ts"] }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("/no/such/missing.ts");
		expect(registry.size).toBe(0);
	});

	it("returns a clear error when the child fails at startup", async () => {
		const client = new FakeClient();
		client.startError = new Error("unknown model");
		const { tools, registry, ctx } = setup(client);
		const result = await tools.spawn({ task: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("returns a clear error when the first prompt is handled", async () => {
		const client = new FakeClient();
		client.promptDisposition = "handled";
		const { tools, registry, ctx } = setup(client);
		const result = await tools.spawn({ task: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(registry.size).toBe(0);
		expect(client.stopped).toBe(true);
	});
});

describe("team_steer decision table", () => {
	it("gives an idle teammate a new task", async () => {
		const client = new FakeClient();
		const { tools, registry, ctx } = setup(client);
		const mate = new TeamMateProcess({ name: "alpha", task: "old", state: "idle", client });
		registry.add(mate);
		const result = await tools.steer({ teammate: "alpha", message: "new task" }, ctx);
		expect(result.isError).toBeFalsy();
		expect(client.promptCalls).toEqual(["new task"]);
		expect(mate.state).toBe("running");
	});

	it("errors when the idle prompt returns handled", async () => {
		const client = new FakeClient();
		client.promptDisposition = "handled";
		const { tools, registry, ctx } = setup(client);
		registry.add(new TeamMateProcess({ name: "alpha", task: "old", state: "idle", client }));
		const result = await tools.steer({ teammate: "alpha", message: "new task" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("handled");
	});

	it("steers a running teammate in interrupt mode", async () => {
		const client = new FakeClient();
		const { tools, registry, ctx } = setup(client);
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "running", client }));
		const result = await tools.steer({ teammate: "alpha", message: "stop that" }, ctx);
		expect(result.isError).toBeFalsy();
		expect(client.steerCalls).toEqual(["stop that"]);
	});

	it("queues a follow-up in queue mode", async () => {
		const client = new FakeClient();
		const { tools, registry, ctx } = setup(client);
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "running", client }));
		const result = await tools.steer({ teammate: "alpha", message: "after this", mode: "queue" }, ctx);
		expect(result.isError).toBeFalsy();
		expect(client.followUpCalls).toEqual(["after this"]);
	});

	it("errors when steer returns handled", async () => {
		const client = new FakeClient();
		client.steerDisposition = "handled";
		const { tools, registry, ctx } = setup(client);
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "running", client }));
		const result = await tools.steer({ teammate: "alpha", message: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("state is unchanged");
	});

	it("errors for the starting state", async () => {
		const { tools, registry, ctx } = setup();
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "starting" }));
		const result = await tools.steer({ teammate: "alpha", message: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("starting");
	});

	it("errors for the failed state", async () => {
		const { tools, registry, ctx } = setup();
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "failed" }));
		const result = await tools.steer({ teammate: "alpha", message: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("team_stop");
	});

	it("errors for a frozen stub", async () => {
		const { tools, registry, ctx } = setup();
		registry.restore({ teammates: [{ name: "ghost", state: "idle", task: "t" }] }, "note");
		const result = await tools.steer({ teammate: "ghost", message: "x" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("frozen");
	});
});

describe("team_stop", () => {
	it("stops one teammate and removes the entry", async () => {
		const client = new FakeClient();
		const { tools, registry } = setup(client);
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "running", client }));
		const result = await tools.stop({ teammate: "alpha" });
		expect(result.isError).toBeFalsy();
		expect(client.stopped).toBe(true);
		expect(registry.get("alpha")).toBeUndefined();
		expect(result.content[0]?.text).toContain("No deliverable will exist");
	});

	it("stops all teammates in parallel and clears failed entries", async () => {
		const c1 = new FakeClient();
		const c2 = new FakeClient();
		const { tools, registry } = setup(c1);
		registry.add(new TeamMateProcess({ name: "a", task: "t", state: "running", client: c1 }));
		registry.add(new TeamMateProcess({ name: "b", task: "t", state: "failed", client: c2 }));
		const result = await tools.stop({ all: true });
		expect(result.isError).toBeFalsy();
		expect(c1.stopped).toBe(true);
		expect(c2.stopped).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("requires a name or all", async () => {
		const { tools } = setup();
		expect((await tools.stop({})).isError).toBe(true);
	});

	it("errors for an unknown name", async () => {
		const { tools } = setup();
		expect((await tools.stop({ teammate: "nope" })).isError).toBe(true);
	});
});

describe("cost retention", () => {
	it("retains costs across task completion, follow-up, and stop", async () => {
		const { tools, registry, client, ctx, statuses } = setup();
		await tools.spawn({ name: "alpha", task: "first" }, ctx);
		client.emit({ type: "agent_start" });
		client.emit({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.1 } } } });
		client.emit({ type: "tool_execution_start", toolName: "report_result", args: { status: "success", summary: "done" } });
		client.statsResult = { cost: 0.13 };
		client.emit({ type: "agent_settled" });
		await vi.waitFor(() => expect(registry.totalCost).toBeCloseTo(0.13));
		await tools.steer({ teammate: "alpha", message: "second" }, ctx);
		client.emit({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.025 } } } });
		expect(registry.totalCost).toBeCloseTo(0.155);
		client.statsResult = { cost: 0.16 };
		await tools.stop({ teammate: "alpha" });
		expect(registry.size).toBe(0);
		expect(registry.totalCost).toBeCloseTo(0.16);
		expect(statuses.at(-1)).toEqual(["pi-team", "🤖 $0.160"]);
		await tools.stop({ all: true });
		expect(registry.totalCost).toBeCloseTo(0.16);
	});

	it("preserves failed and stopped costs when stopping all", async () => {
		const { tools, registry, statuses } = setup();
		registry.add(new TeamMateProcess({ name: "a", task: "a", state: "failed", cost: 0.12 }));
		registry.add(new TeamMateProcess({ name: "b", task: "b", state: "idle", cost: 0.03 }));
		await tools.stop({ all: true });
		expect(registry.totalCost).toBeCloseTo(0.15);
		expect(statuses.at(-1)).toEqual(["pi-team", "🤖 $0.150"]);
	});

	it("does not remove a replacement after an old stop finishes", async () => {
		const { tools, registry, client } = setup();
		let finishStop!: () => void;
		client.stop = () => new Promise((resolve) => { finishStop = resolve; });
		const original = new TeamMateProcess({ name: "alpha", task: "old", state: "running", client, cost: 0.1 });
		registry.add(original);
		const stopped = tools.stop({ teammate: "alpha" });
		await vi.waitFor(() => expect(finishStop).toBeDefined());
		registry.remove("alpha");
		const replacement = new TeamMateProcess({ name: "alpha", task: "new", state: "running", cost: 0.2 });
		registry.add(replacement);
		finishStop();
		await stopped;
		expect(registry.get("alpha")).toBe(replacement);
		expect(registry.totalCost).toBeCloseTo(0.3);
	});
});

describe("team_status and team_result", () => {
	it("reports no teammates", async () => {
		const { tools } = setup();
		const status = await tools.status({});
		expect(status.content[0]?.text).toBe("No teammates.");
	});

	it("does not reconcile cost from observational detailed statistics", async () => {
		const { tools, registry, client } = setup();
		client.statsResult = { cost: 0.9 };
		const mate = new TeamMateProcess({ name: "alpha", task: "work", state: "running", client, cost: 0.1 });
		registry.add(mate);
		await tools.status({ detail: true });
		expect(registry.totalCost).toBeCloseTo(0.1);
	});

	it("reports rows for all teammates", async () => {
		const { tools, registry } = setup();
		registry.add(new TeamMateProcess({ name: "alpha", task: "a very long task description", state: "running" }));
		const result = await tools.status({});
		expect(result.structuredContent).toMatchObject({
			counts: { running: 1, idle: 0, failed: 0 },
			teammates: [{ name: "alpha", state: "running" }],
		});
	});

	it("errors for an unknown teammate in team_status", async () => {
		const { tools } = setup();
		expect((await tools.status({ teammate: "nope" })).isError).toBe(true);
	});

	it("says a starting teammate has no result", async () => {
		const { tools, registry } = setup();
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "starting" }));
		expect((await tools.result({ teammate: "alpha" })).content[0]?.text).toContain("is starting");
	});

	it("says a running teammate is still working", async () => {
		const { tools, registry } = setup();
		const mate = new TeamMateProcess({ name: "alpha", task: "t", state: "running" });
		mate.currentTool = "bash";
		registry.add(mate);
		const result = await tools.result({ teammate: "alpha" });
		expect(result.content[0]?.text).toContain("still working");
		expect(result.structuredContent).toMatchObject({ state: "running", currentTool: "bash" });
	});

	it("returns a stored deliverable", async () => {
		const { tools, registry } = setup();
		registry.add(
			new TeamMateProcess({
				name: "alpha",
				task: "t",
				state: "idle",
				deliverable: { reported: true, status: "success", summary: "done", data: { n: 1 }, capturedAt: 9 },
			}),
		);
		const result = await tools.result({ teammate: "alpha" });
		expect(result.structuredContent).toMatchObject({
			name: "alpha",
			state: "idle",
			resultReady: true,
			reported: true,
			status: "success",
			data: { n: 1 },
		});
	});

	it("explains a failed teammate without a result", async () => {
		const { tools, registry } = setup();
		registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "failed", failureNote: "process exited" }));
		const result = await tools.result({ teammate: "alpha" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("process exited");
	});
});
