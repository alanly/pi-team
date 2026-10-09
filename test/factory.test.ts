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
		expect(readLatestSnapshot(ctx)).toEqual([{ name: "a", state: "idle", task: "t" }]);
	});

	it("returns undefined without a registry entry", () => {
		const { ctx } = mockContext();
		expect(readLatestSnapshot(ctx)).toBeUndefined();
	});
});
