import { describe, expect, it, vi } from "vitest";
import { TeamMateProcess } from "../src/process.ts";
import { TeamRegistry } from "../src/registry.ts";
import { CT_TEAM_REGISTRY, type RegistrySnapshot, type RegistrySnapshotEntry } from "../src/types.ts";
import { FakeClient, mockPi } from "./fakes.ts";

function mate(
	name: string,
	state: "starting" | "running" | "idle" | "failed",
	cost = 0,
	client?: FakeClient,
) {
	return new TeamMateProcess({ name, task: `task for ${name}`, state, cost, client });
}

function flushMicrotasks() {
	return new Promise<void>((resolve) => queueMicrotask(() => resolve()));
}

function snapshot(teammates: RegistrySnapshotEntry[], totalCost?: number): RegistrySnapshot {
	return totalCost === undefined ? { teammates } : { teammates, totalCost };
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

	it("stops every teammate in parallel", async () => {
		const registry = new TeamRegistry();
		const c1 = new FakeClient();
		const c2 = new FakeClient();
		registry.add(mate("a", "running", 0, c1));
		registry.add(mate("b", "idle", 0, c2));
		await registry.stopAll();
		expect(c1.stopped).toBe(true);
		expect(c2.stopped).toBe(true);
	});
});

describe("TeamRegistry cost accounting", () => {
	it("sums the cost of every live teammate", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "running", 0.1));
		registry.add(mate("b", "idle", 0.2));
		expect(registry.totalCost).toBeCloseTo(0.3);
	});

	it("keeps a removed teammate's cost in the total", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "idle", 0.1));
		registry.remove("a");
		expect(registry.totalCost).toBeCloseTo(0.1);
		registry.remove("a");
		expect(registry.totalCost).toBeCloseTo(0.1);
	});

	it("retains historical cost after stop-all and removal", async () => {
		const registry = new TeamRegistry();
		const c1 = new FakeClient();
		const c2 = new FakeClient();
		registry.add(mate("a", "running", 0.1, c1));
		registry.add(mate("b", "idle", 0.2, c2));
		await registry.stopAll();
		registry.remove("a");
		registry.remove("b");
		registry.remove("a");
		expect(registry.totalCost).toBeCloseTo(0.3);
		expect(registry.size).toBe(0);
	});

	it("rejects a duplicate name without overwriting", () => {
		const registry = new TeamRegistry();
		const first = mate("a", "idle", 0.1);
		registry.add(first);
		expect(() => registry.add(mate("a", "idle", 5))).toThrow(/already exists/);
		expect(registry.get("a")).toBe(first);
		expect(registry.totalCost).toBeCloseTo(0.1);
	});

	it("counts a reused name as a separate contribution", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "idle", 0.1));
		registry.remove("a");
		registry.add(mate("a", "idle", 0.05));
		expect(registry.totalCost).toBeCloseTo(0.15);
	});

	it("snapshots per-entry and aggregate costs including zero", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "idle", 0));
		expect(registry.snapshot()).toEqual({
			teammates: [{ name: "a", state: "idle", task: "task for a", cost: 0 }],
			totalCost: 0,
		});
		registry.add(mate("b", "running", 0.25));
		expect(registry.snapshot()).toEqual({
			teammates: [
				{ name: "a", state: "idle", task: "task for a", cost: 0 },
				{ name: "b", state: "running", task: "task for b", cost: 0.25 },
			],
			totalCost: 0.25,
		});
	});
});

describe("TeamRegistry persistence", () => {
	it("persists one snapshot per microtask burst", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.1));
		registry.persist();
		registry.persist();
		registry.persist();
		expect(calls.entries).toHaveLength(0);
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(1);
		expect(calls.entries[0]?.[0]).toBe(CT_TEAM_REGISTRY);
		expect(calls.entries[0]?.[1]).toEqual({
			teammates: [{ name: "a", state: "idle", task: "task for a", cost: 0.1 }],
			totalCost: 0.1,
		});
	});

	it("skips a queued write when nothing changed", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.1));
		registry.persistNow();
		expect(calls.entries).toHaveLength(1);
		registry.persist();
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(1);
		registry.remove("a");
		registry.persist();
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(2);
	});

	it("persistNow cancels the queued write", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.1));
		registry.persist();
		registry.persistNow();
		expect(calls.entries).toHaveLength(1);
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(1);
	});

	it("persistNow is blocked once closed", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.1));
		registry.close();
		registry.persistNow();
		expect(calls.entries).toHaveLength(0);
		registry.persist();
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(0);
	});

	it("close cancels a queued write and blocks later ones", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.1));
		registry.persist();
		registry.close();
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(0);
		registry.persist();
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(0);
	});

	it("persistFinal writes one changed snapshot after close and skips identical repeats", () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.138));
		registry.close();
		registry.persistFinal();
		expect(calls.entries).toHaveLength(1);
		expect(calls.entries[0]?.[1]).toEqual({
			teammates: [{ name: "a", state: "idle", task: "task for a", cost: 0.138 }],
			totalCost: 0.138,
		});
		registry.persistFinal();
		expect(calls.entries).toHaveLength(1);
	});

	it("persistFinal adds nothing for a pristine closed registry", () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.close();
		registry.persistFinal();
		expect(calls.entries).toHaveLength(0);
	});

	it("contains an appendEntry failure in a queued write", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.add(mate("a", "idle", 0.1));
		vi.mocked(pi.appendEntry).mockImplementationOnce(() => {
			throw new Error("stale runtime");
		});
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			registry.persist();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(rejections).toEqual([]);
		expect(calls.entries).toHaveLength(0);
		registry.persistNow();
		expect(calls.entries).toHaveLength(1);
	});
});

describe("restore", () => {
	it("turns running and starting entries into failed with the note", () => {
		const registry = new TeamRegistry();
		const restored = registry.restore(
			snapshot([
				{ name: "a", state: "running", task: "one", cost: 0.1 },
				{ name: "b", state: "starting", task: "two" },
			]),
			"parent session restarted",
		);
		expect(restored.map((m) => m.state)).toEqual(["failed", "failed"]);
		expect(restored[0]?.failureNote).toBe("parent session restarted");
		expect(restored[0]?.frozen).toBe(true);
	});

	it("keeps idle entries and their deliverable", () => {
		const registry = new TeamRegistry();
		const deliverable = { reported: true as const, status: "success" as const, summary: "done", capturedAt: 1 };
		registry.restore(snapshot([{ name: "a", state: "idle", task: "one", deliverable }]), "note");
		const stored = registry.get("a")!;
		expect(stored.state).toBe("idle");
		expect(stored.result()).toEqual(deliverable);
		expect(stored.failureNote).toBeUndefined();
	});

	it("does not overwrite an existing name", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "idle"));
		const restored = registry.restore(snapshot([{ name: "a", state: "idle", task: "x" }]), "note");
		expect(restored).toHaveLength(0);
	});

	it("restores entry costs and infers retired spend from the aggregate", () => {
		const registry = new TeamRegistry();
		registry.restore(snapshot([{ name: "a", state: "idle", task: "one", cost: 0.1 }], 0.138), "note");
		expect(registry.get("a")?.cost).toBeCloseTo(0.1);
		expect(registry.totalCost).toBeCloseTo(0.138);
		registry.remove("a");
		expect(registry.totalCost).toBeCloseTo(0.138);
	});

	it("defaults missing and invalid entry costs to zero", () => {
		const registry = new TeamRegistry();
		const restored = registry.restore(
			snapshot(
				[
					{ name: "legacy", state: "idle", task: "t" },
					{ name: "neg", state: "idle", task: "t", cost: -1 },
					{ name: "nan", state: "idle", task: "t", cost: Number.NaN },
					{ name: "str", state: "idle", task: "t", cost: "0.1" as unknown as number },
					{ name: "inf", state: "idle", task: "t", cost: Number.POSITIVE_INFINITY },
				],
				0.5,
			),
			"note",
		);
		expect(restored.map((m) => m.cost)).toEqual([0, 0, 0, 0, 0]);
		expect(registry.totalCost).toBeCloseTo(0.5);
	});

	it("keeps the entry-cost sum when the aggregate is invalid or missing", () => {
		const withNegative = new TeamRegistry();
		withNegative.restore(snapshot([{ name: "a", state: "idle", task: "t", cost: 0.1 }], -5), "note");
		expect(withNegative.totalCost).toBeCloseTo(0.1);

		const withString = new TeamRegistry();
		withString.restore(snapshot([{ name: "a", state: "idle", task: "t", cost: 0.1 }], "x" as unknown as number), "note");
		expect(withString.totalCost).toBeCloseTo(0.1);

		const withoutAggregate = new TeamRegistry();
		withoutAggregate.restore(snapshot([{ name: "a", state: "idle", task: "t", cost: 0.1 }]), "note");
		expect(withoutAggregate.totalCost).toBeCloseTo(0.1);
	});

	it("restores a cost-only line from an empty snapshot with an aggregate", () => {
		const registry = new TeamRegistry();
		registry.restore(snapshot([], 0.138), "note");
		expect(registry.size).toBe(0);
		expect(registry.totalCost).toBeCloseTo(0.138);
	});

	it("restores no spend from a legacy empty snapshot", () => {
		const registry = new TeamRegistry();
		registry.restore(snapshot([]), "note");
		expect(registry.size).toBe(0);
		expect(registry.totalCost).toBe(0);
	});

	it("deduplicates entries by name, keeping the first", () => {
		const registry = new TeamRegistry();
		registry.restore(
			snapshot(
				[
					{ name: "a", state: "idle", task: "first", cost: 0.1 },
					{ name: "a", state: "idle", task: "second", cost: 0.9 },
				],
				1,
			),
			"note",
		);
		expect(registry.size).toBe(1);
		expect(registry.get("a")?.cost).toBeCloseTo(0.1);
		expect(registry.get("a")?.task).toBe("first");
		expect(registry.totalCost).toBeCloseTo(1);
	});

	it("skips malformed entries", () => {
		const registry = new TeamRegistry();
		const malformed = [
			null,
			"x",
			{ name: 5, state: "idle", task: "t" },
			{ name: "a", state: "idle", task: "t", cost: 0.1 },
		] as unknown as RegistrySnapshotEntry[];
		registry.restore(snapshot(malformed, 0.2), "note");
		expect(registry.size).toBe(1);
		expect(registry.get("a")?.cost).toBeCloseTo(0.1);
		expect(registry.totalCost).toBeCloseTo(0.2);
	});

	it("removes a restored stub once without changing the total", () => {
		const registry = new TeamRegistry();
		registry.restore(snapshot([{ name: "a", state: "idle", task: "t", cost: 0.1 }], 0.1), "note");
		expect(registry.totalCost).toBeCloseTo(0.1);
		registry.remove("a");
		expect(registry.totalCost).toBeCloseTo(0.1);
		registry.remove("a");
		expect(registry.totalCost).toBeCloseTo(0.1);
	});

	it("appends nothing for an unchanged restore", async () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.restore(snapshot([{ name: "a", state: "idle", task: "t", cost: 0.138 }], 0.138), "note");
		registry.persistNow();
		expect(calls.entries).toHaveLength(0);
		registry.persist();
		await flushMicrotasks();
		expect(calls.entries).toHaveLength(0);
	});

	it("still persists a restore that converts state", () => {
		const { pi, calls } = mockPi();
		const registry = new TeamRegistry(pi);
		registry.restore(snapshot([{ name: "a", state: "running", task: "t", cost: 0.1 }], 0.1), "reloaded");
		registry.persistNow();
		expect(calls.entries).toHaveLength(1);
		expect(calls.entries[0]?.[1]).toEqual({
			teammates: [{ name: "a", state: "failed", task: "t", cost: 0.1, failureNote: "reloaded" }],
			totalCost: 0.1,
		});
	});
});
