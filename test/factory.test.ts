import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { createTeamExtension, readLatestSnapshot, restoreNote } from "../src/index.ts";
import { TeamMateProcess } from "../src/process.ts";
import { CT_TEAM_REGISTRY } from "../src/types.ts";
import { FakeClient, mockContext, mockPi } from "./fakes.ts";

type Handler = (event: SessionStartEvent | SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void;

function handlerFor(calls: ReturnType<typeof mockPi>["calls"], event: string): Handler {
	const found = calls.events.find(([name]) => name === event);
	expect(found, `handler for ${event}`).toBeDefined();
	return found![1] as Handler;
}

afterEach(() => {
	delete process.env.PI_TEAMMATE;
	vi.clearAllMocks();
});

describe("factory smoke test", () => {
	it("registers five team tools, the renderer, and the lifecycle handlers", () => {
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		expect(ext.disabled).toBe(false);
		expect(calls.tools.map((tool) => tool.name)).toEqual([
			"team_spawn",
			"team_status",
			"team_result",
			"team_steer",
			"team_stop",
		]);
		for (const tool of calls.tools) {
			expect(tool.namespace?.name).toBe("team");
			expect(tool.executionMode).toBe("sequential");
		}
		const spawn = calls.tools.find((tool) => tool.name === "team_spawn");
		expect(Object.keys((spawn?.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(
			expect.arrayContaining(["extensions"]),
		);
		expect(calls.renderers.map(([customType]) => customType)).toEqual(["team-notify"]);
		expect(calls.events.map(([event]) => event)).toEqual([
			"session_start",
			"agent_start",
			"agent_settled",
			"session_shutdown",
		]);
	});

	it("starts no process in the factory", () => {
		const { pi } = mockPi();
		createTeamExtension(pi, { createClient: () => new FakeClient() });
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("disables the extension when PI_TEAMMATE=1", () => {
		process.env.PI_TEAMMATE = "1";
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		expect(ext.disabled).toBe(true);
		expect(calls.tools).toHaveLength(0);
	});
});

describe("session lifecycle", () => {
	it("stops all teammates on shutdown and is idempotent", async () => {
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		const client = new FakeClient();
		ext.registry.add(new TeamMateProcess({ name: "alpha", task: "t", state: "running", client }));
		const shutdown = handlerFor(calls, "session_shutdown");
		const { ctx, statuses } = mockContext();
		await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(client.stopped).toBe(true);
		expect(ext.registry.size).toBe(0);
		expect(statuses).toContainEqual(["pi-team", undefined]);
	});

	it("restores a running entry as failed after a reload", async () => {
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		const { ctx, entries } = mockContext();
		entries.push({
			type: "custom",
			customType: CT_TEAM_REGISTRY,
			data: { teammates: [{ name: "ghost", state: "running", task: "old" }] },
		});
		const start = handlerFor(calls, "session_start");
		await start({ type: "session_start", reason: "reload" }, ctx);
		const ghost = ext.registry.get("ghost")!;
		expect(ghost.state).toBe("failed");
		expect(ghost.failureNote).toBe("parent session reloaded");
	});

	it("restores nothing for an empty snapshot", async () => {
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		const { ctx, entries } = mockContext();
		entries.push({ type: "custom", customType: CT_TEAM_REGISTRY, data: { teammates: [] } });
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		expect(ext.registry.size).toBe(0);
	});
});

describe("cost persistence and shutdown", () => {
	it("keeps health probes off for cost-only restore and stops them after the last removal", async () => {
		vi.useFakeTimers();
		const intervals = vi.spyOn(globalThis, "setInterval");
		const cleared = vi.spyOn(globalThis, "clearInterval");
		try {
			const { pi, calls } = mockPi();
			const client = new FakeClient();
			client.statsResult = { cost: 0.1 };
			const ext = createTeamExtension(pi, {
				createClient: () => client,
				writePersona: async () => "/tmp/pi-team-test/persona.md",
				removePersona: async () => undefined,
			});
			const { ctx, entries, statuses } = mockContext();
			entries.push({ type: "custom", customType: CT_TEAM_REGISTRY, data: { teammates: [], totalCost: 0.138 } });
			await handlerFor(calls, "session_start")({ type: "session_start", reason: "resume" }, ctx);
			expect(intervals).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			await ext.tools.spawn({ task: "work", name: "alpha" }, ctx);
			expect(intervals).toHaveBeenCalledTimes(1);
			await ext.tools.stop({ teammate: "alpha" });
			expect(cleared).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
			expect(statuses.at(-1)).toEqual(["pi-team", "🤖 $0.238"]);
			await handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
		} finally {
			intervals.mockRestore();
			cleared.mockRestore();
			vi.useRealTimers();
		}
	});

	it("restores the newest cost-only snapshot instead of older teammates", async () => {
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		const { ctx, entries, statuses } = mockContext();
		entries.push(
			{ type: "custom", customType: CT_TEAM_REGISTRY, data: { teammates: [{ name: "old", state: "idle", task: "old" }] } },
			{ type: "custom", customType: CT_TEAM_REGISTRY, data: { teammates: [], totalCost: 0.138 } },
		);
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "resume" }, ctx);
		expect(ext.registry.size).toBe(0);
		expect(ext.registry.totalCost).toBe(0.138);
		expect(statuses).toContainEqual(["pi-team", "🤖 $0.138"]);
		await handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(calls.entries).toHaveLength(0);
	});

	it("writes one final snapshot before clearing metadata and cancels a queued write", async () => {
		const { pi, calls } = mockPi();
		const ext = createTeamExtension(pi);
		const client = new FakeClient();
		client.statsResult = { cost: 0.25 };
		const stop = vi.spyOn(client, "stop");
		ext.registry.add(new TeamMateProcess({ name: "alpha", task: "unfinished", state: "running", client }));
		ext.registry.persist();
		const { ctx, statuses } = mockContext();
		const shutdown = handlerFor(calls, "session_shutdown");
		await Promise.all([
			shutdown({ type: "session_shutdown", reason: "reload" }, ctx),
			shutdown({ type: "session_shutdown", reason: "reload" }, ctx),
		]);
		await Promise.resolve();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(calls.entries).toEqual([[CT_TEAM_REGISTRY, {
			teammates: [{ name: "alpha", state: "running", task: "unfinished", cost: 0.25 }],
			totalCost: 0.25,
		}]]);
		expect(ext.registry.size).toBe(0);
		expect(statuses.at(-1)).toEqual(["pi-team", undefined]);
	});

	it("does not write a snapshot for a pristine session", async () => {
		const { pi, calls } = mockPi();
		createTeamExtension(pi);
		const { ctx } = mockContext();
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		await handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(calls.entries).toHaveLength(0);
	});

	it("does not touch stale Pi APIs when a fallback resolves after shutdown", async () => {
		const { pi, calls } = mockPi();
		const client = new FakeClient();
		let resolveText!: (text: string) => void;
		client.getLastAssistantText = () => new Promise((resolve) => { resolveText = resolve; });
		const ext = createTeamExtension(pi, {
			createClient: () => client,
			writePersona: async () => "/tmp/pi-team-test/persona.md",
			removePersona: async () => undefined,
		});
		const { ctx } = mockContext();
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		await ext.tools.spawn({ task: "pending", name: "alpha" }, ctx);
		client.emit({ type: "agent_start" });
		client.emit({ type: "agent_settled" });
		await handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
		vi.mocked(pi.appendEntry).mockImplementation(() => { throw new Error("stale pi"); });
		vi.mocked(pi.sendMessage).mockImplementation(() => { throw new Error("stale pi"); });
		Object.defineProperty(ctx, "mode", { get: () => { throw new Error("stale ctx"); } });
		const before = { entries: calls.entries.length, messages: calls.messages.length };
		resolveText("late result");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.entries).toHaveLength(before.entries);
		expect(calls.messages).toHaveLength(before.messages);
		expect(ext.registry.size).toBe(0);
	});

	it("ignores deferred statistics and probe replies after the runtime closes", async () => {
		const { pi, calls } = mockPi();
		const client = new FakeClient();
		let resolveStats!: (stats: unknown) => void;
		let resolveState!: (state: unknown) => void;
		const pendingStats = new Promise((resolve) => { resolveStats = resolve; });
		client.getSessionStats = vi.fn()
			.mockImplementationOnce(() => pendingStats)
			.mockResolvedValue({ cost: 0.2 });
		client.getState = () => new Promise((resolve) => { resolveState = resolve; });
		const ext = createTeamExtension(pi, {
			createClient: () => client,
			writePersona: async () => "/tmp/pi-team-test/persona.md",
			removePersona: async () => undefined,
		});
		const { ctx } = mockContext();
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		await ext.tools.spawn({ task: "pending", name: "alpha" }, ctx);
		client.emit({ type: "tool_execution_start", toolName: "report_result", args: { status: "success", summary: "done" } });
		client.emit({ type: "agent_settled" });
		const tick = ext.poller.tick();
		await handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
		vi.mocked(pi.appendEntry).mockImplementation(() => { throw new Error("stale pi"); });
		vi.mocked(pi.sendMessage).mockImplementation(() => { throw new Error("stale pi"); });
		Object.defineProperty(ctx, "mode", { get: () => { throw new Error("stale ctx"); } });
		const before = { entries: calls.entries.length, messages: calls.messages.length };
		resolveStats({ cost: 9 });
		resolveState({ isStreaming: false });
		await tick;
		await Promise.resolve();
		expect(calls.entries).toHaveLength(before.entries);
		expect(calls.messages).toHaveLength(before.messages);
		const finalSnapshot = calls.entries.filter(([type]) => type === CT_TEAM_REGISTRY).at(-1)?.[1];
		expect(finalSnapshot).toMatchObject({ totalCost: 0.2 });
	});

	it("shares child finalization between explicit stop and shutdown", async () => {
		const { pi, calls } = mockPi();
		const client = new FakeClient();
		let resolveStats!: (stats: unknown) => void;
		client.getSessionStats = () => new Promise((resolve) => { resolveStats = resolve; });
		const stop = vi.spyOn(client, "stop");
		const ext = createTeamExtension(pi, {
			createClient: () => client,
			writePersona: async () => "/tmp/pi-team-test/persona.md",
			removePersona: async () => undefined,
		});
		const { ctx } = mockContext();
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		await ext.tools.spawn({ task: "unfinished", name: "alpha" }, ctx);
		client.emit({ type: "agent_start" });
		const stopping = ext.tools.stop({ teammate: "alpha" });
		const shutdown = handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
		resolveStats({ cost: 0.25 });
		await Promise.all([stopping, shutdown]);
		expect(stop).toHaveBeenCalledTimes(1);
		const snapshots = calls.entries.filter(([type]) => type === CT_TEAM_REGISTRY);
		expect(snapshots.at(-1)?.[1]).toMatchObject({
			teammates: [{ name: "alpha", state: "running", task: "unfinished", cost: 0.25 }],
			totalCost: 0.25,
		});
		expect(ext.registry.size).toBe(0);
	});

	it("cleans up a spawn that finishes after shutdown", async () => {
		const { pi, calls } = mockPi();
		const client = new FakeClient();
		let resolvePrompt!: (value: "started") => void;
		client.prompt = vi.fn(() => new Promise<"started">((resolve) => { resolvePrompt = resolve; }));
		const removePersona = vi.fn(async () => undefined);
		const ext = createTeamExtension(pi, {
			createClient: () => client,
			writePersona: async () => "/tmp/pi-team-test/persona.md",
			removePersona,
		});
		const { ctx } = mockContext();
		await handlerFor(calls, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		const spawned = ext.tools.spawn({ task: "pending", name: "alpha" }, ctx);
		await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
		await handlerFor(calls, "session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
		resolvePrompt("started");
		expect((await spawned).isError).toBe(true);
		expect(client.stopped).toBe(true);
		expect(removePersona).toHaveBeenCalledTimes(1);
		expect(ext.registry.size).toBe(0);
	});
});

describe("restore helpers", () => {
	it("maps session reasons to notes", () => {
		expect(restoreNote("startup")).toBe("parent session restarted");
		expect(restoreNote("reload")).toBe("parent session reloaded");
		expect(restoreNote("resume")).toBe("parent session resumed");
		expect(restoreNote("fork")).toBe("forked session");
	});

	it("reads the newest snapshot", () => {
		const { ctx, entries } = mockContext();
		entries.push({ type: "custom", customType: CT_TEAM_REGISTRY, data: { teammates: [{ name: "a", state: "idle", task: "t" }] } });
		entries.push({ type: "custom", customType: "other", data: {} });
		expect(readLatestSnapshot(ctx)).toEqual({ teammates: [{ name: "a", state: "idle", task: "t" }] });
	});

	it("returns undefined without a registry entry", () => {
		const { ctx } = mockContext();
		expect(readLatestSnapshot(ctx)).toBeUndefined();
	});
});
