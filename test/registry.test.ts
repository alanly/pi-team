import { describe, expect, it, vi } from "vitest";
import { TeamMateProcess } from "../src/process.ts";
import { TeamRegistry } from "../src/registry.ts";
import { CT_TEAM_REGISTRY } from "../src/types.ts";
import { FakeClient, mockPi } from "./fakes.ts";

function mate(name: string, state: "starting" | "running" | "idle" | "failed", client?: FakeClient) {
	return new TeamMateProcess({ name, task: `task for ${name}`, state, client });
}

describe("TeamRegistry", () => {
	it("counts running including starting", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "starting"));
		registry.add(mate("b", "running"));
		registry.add(mate("c", "idle"));
		registry.add(mate("d", "failed"));
		expect(registry.counts()).toEqual({ running: 2, idle: 1, failed: 1 });
	});

	it("generates unique default names", () => {
		const registry = new TeamRegistry();
		expect(registry.nextName()).toBe("teammate-1");
		registry.add(mate("teammate-2", "idle"));
		expect(registry.nextName()).toBe("teammate-3");
	});

	it("removes entries", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "idle"));
		expect(registry.get("a")?.name).toBe("a");
		registry.remove("a");
		expect(registry.get("a")).toBeUndefined();
		expect(registry.size).toBe(0);
	});

	it("persists one snapshot per microtask burst", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle"));
		registry.persist();
		registry.persist();
		registry.persist();
		expect(calls.entries).toHaveLength(0);
		await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
		expect(calls.entries).toHaveLength(1);
		expect(calls.entries[0]?.[0]).toBe(CT_TEAM_REGISTRY);
	});

	it("stops every teammate in parallel", async () => {
		const registry = new TeamRegistry();
		const c1 = new FakeClient();
		const c2 = new FakeClient();
		registry.add(mate("a", "running", c1));
		registry.add(mate("b", "idle", c2));
		await registry.stopAll();
		expect(c1.stopped).toBe(true);
		expect(c2.stopped).toBe(true);
	});

	describe("restore", () => {
		it("turns running and starting entries into failed with the note", () => {
			const registry = new TeamRegistry();
			const restored = registry.restore(
				[
					{ name: "a", state: "running", task: "one" },
					{ name: "b", state: "starting", task: "two" },
				],
				"parent session restarted",
			);
			expect(restored.map((m) => m.state)).toEqual(["failed", "failed"]);
			expect(restored[0]?.failureNote).toBe("parent session restarted");
			expect(restored[0]?.frozen).toBe(true);
		});

		it("keeps idle entries and their deliverable", () => {
			const registry = new TeamRegistry();
			const deliverable = { reported: true as const, status: "success" as const, summary: "done", capturedAt: 1 };
			registry.restore([{ name: "a", state: "idle", task: "one", deliverable }], "note");
			const stored = registry.get("a")!;
			expect(stored.state).toBe("idle");
			expect(stored.result()).toEqual(deliverable);
			expect(stored.failureNote).toBeUndefined();
		});

		it("does not overwrite an existing name", () => {
			const registry = new TeamRegistry();
			registry.add(mate("a", "idle"));
			const restored = registry.restore([{ name: "a", state: "idle", task: "x" }], "note");
			expect(restored).toHaveLength(0);
		});
	});
});
