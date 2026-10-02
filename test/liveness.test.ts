import { describe, expect, it, vi } from "vitest";
import { LivenessPoller, TeamMateProcess } from "../src/process.ts";
import { FakeClient } from "./fakes.ts";

function fakeRegistry() {
	const mates: TeamMateProcess[] = [];
	return {
		mates,
		size: 0,
		all: () => mates,
		add(mate: TeamMateProcess) {
			mates.push(mate);
			this.size = mates.length;
		},
		set(mates2: TeamMateProcess[]) {
			this.mates.length = 0;
			this.mates.push(...mates2);
			this.size = mates2.length;
		},
	};
}

describe("LivenessPoller", () => {
	it("starts no timer for an empty registry", () => {
		const setIntervalFn = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
		const clearIntervalFn = vi.fn();
		const registry = fakeRegistry();
		const poller = new LivenessPoller({
			registry,
			intervalMs: 1000,
			onStateChange: vi.fn(),
			setInterval: setIntervalFn,
			clearInterval: clearIntervalFn,
		});
		poller.ensureRunning();
		expect(setIntervalFn).not.toHaveBeenCalled();
	});

	it("starts one timer when teammates exist and clears it on stop", () => {
		const setIntervalFn = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
		const clearIntervalFn = vi.fn();
		const registry = fakeRegistry();
		registry.add(new TeamMateProcess({ name: "a", task: "t", state: "running", client: new FakeClient() }));
		const poller = new LivenessPoller({
			registry,
			intervalMs: 1000,
			onStateChange: vi.fn(),
			setInterval: setIntervalFn,
			clearInterval: clearIntervalFn,
		});
		poller.ensureRunning();
		poller.ensureRunning();
		expect(setIntervalFn).toHaveBeenCalledTimes(1);
		poller.stop();
		expect(clearIntervalFn).toHaveBeenCalledWith(7);
	});

	it("probes every teammate and refreshes after a tick", async () => {
		const registry = fakeRegistry();
		const client = new FakeClient();
		const mate = new TeamMateProcess({ name: "a", task: "t", state: "running", client });
		registry.add(mate);
		const onStateChange = vi.fn();
		const poller = new LivenessPoller({ registry, intervalMs: 1000, onStateChange });
		await poller.tick();
		expect(onStateChange).toHaveBeenCalledTimes(1);
		expect(client.stopped).toBe(false);
	});

	it("stops the timer when the registry becomes empty on a tick", async () => {
		const clearIntervalFn = vi.fn();
		const registry = fakeRegistry();
		registry.add(new TeamMateProcess({ name: "a", task: "t", state: "running", client: new FakeClient() }));
		const poller = new LivenessPoller({
			registry,
			intervalMs: 1000,
			onStateChange: vi.fn(),
			setInterval: vi.fn(() => 3 as unknown as ReturnType<typeof setInterval>),
			clearInterval: clearIntervalFn,
		});
		poller.ensureRunning();
		await poller.tick();
		expect(clearIntervalFn).not.toHaveBeenCalled();
		registry.set([]);
		await poller.tick();
		expect(clearIntervalFn).toHaveBeenCalledWith(3);
	});
});
