import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamMateProcess } from "../src/process.ts";
import { TeamRegistry } from "../src/registry.ts";
import { StatusLine, formatStatusLine } from "../src/statusline.ts";
import { mockContext } from "./fakes.ts";

const identity = (_color: string, text: string) => text;

function mate(name: string, state: "starting" | "running" | "idle" | "failed", cost = 0) {
	return new TeamMateProcess({ name, task: `task for ${name}`, state, cost });
}

describe("formatStatusLine", () => {
	it("appends the cost to every line with entries, even when zero", () => {
		expect(formatStatusLine({ running: 1, idle: 0, failed: 0 }, 0, identity)).toBe("🤖 1 running · $0.000");
		expect(formatStatusLine({ running: 3, idle: 0, failed: 0 }, 1.5, identity)).toBe("🤖 3 running · $1.500");
	});

	it("joins all segments with ' · ' and puts the cost last", () => {
		expect(formatStatusLine({ running: 2, idle: 1, failed: 0 }, 0.138, identity)).toBe(
			"🤖 2 running · 1 idle · $0.138",
		);
		expect(formatStatusLine({ running: 2, idle: 1, failed: 1 }, 0.138, identity)).toBe(
			"🤖 2 running · 1 idle · 1 failed · $0.138",
		);
	});

	it("shows the failed segment before the cost", () => {
		expect(formatStatusLine({ running: 0, idle: 1, failed: 1 }, 0.138, identity)).toBe(
			"🤖 1 idle · 1 failed · $0.138",
		);
		expect(formatStatusLine({ running: 0, idle: 0, failed: 1 }, 0.138, identity)).toBe("🤖 1 failed · $0.138");
	});

	it("omits each zero count segment", () => {
		expect(formatStatusLine({ running: 0, idle: 1, failed: 0 }, 0, identity)).toBe("🤖 1 idle · $0.000");
		expect(formatStatusLine({ running: 1, idle: 0, failed: 2 }, 0.2, identity)).toBe(
			"🤖 1 running · 2 failed · $0.200",
		);
		expect(formatStatusLine({ running: 0, idle: 1, failed: 2 }, 0, identity)).toBe("🤖 1 idle · 2 failed · $0.000");
	});

	it("rounds the cost to three decimals only for display", () => {
		expect(formatStatusLine({ running: 1, idle: 0, failed: 0 }, 0.1384999, identity)).toBe(
			"🤖 1 running · $0.138",
		);
		expect(formatStatusLine({ running: 1, idle: 0, failed: 0 }, 0.1, identity)).toBe("🤖 1 running · $0.100");
	});

	it("shows a cost-only line while the unrounded total is positive", () => {
		expect(formatStatusLine({ running: 0, idle: 0, failed: 0 }, 0.138, identity)).toBe("🤖 $0.138");
	});

	it("keeps a cost-only line for a sub-mill positive total", () => {
		expect(formatStatusLine({ running: 0, idle: 0, failed: 0 }, 0.0004, identity)).toBe("🤖 $0.000");
	});

	it("returns undefined when no entries exist and the total is zero", () => {
		expect(formatStatusLine({ running: 0, idle: 0, failed: 0 }, 0, identity)).toBeUndefined();
	});

	it("passes theme colors per segment including dim for the cost", () => {
		const seen: Array<[string, string]> = [];
		const fg = (color: string, text: string) => {
			seen.push([color, text]);
			return text;
		};
		formatStatusLine({ running: 1, idle: 1, failed: 1 }, 0.138, fg);
		expect(seen).toEqual([
			["accent", "1 running"],
			["success", "1 idle"],
			["error", "1 failed"],
			["dim", "$0.138"],
		]);
	});
});

describe("StatusLine", () => {
	it("renders the counts followed by the registry cost", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "running", 0.1));
		registry.add(mate("b", "idle", 0.038));
		const { ctx, statuses } = mockContext();
		registry.captureContext(ctx);
		new StatusLine(registry).refresh();
		expect(statuses).toEqual([["pi-team", "🤖 1 running · 1 idle · $0.138"]]);
	});

	it("keeps a cost-only line after the last teammate is removed", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "idle", 0.138));
		const { ctx, statuses } = mockContext();
		registry.captureContext(ctx);
		const statusline = new StatusLine(registry);
		statusline.refresh();
		registry.remove("a");
		statusline.refresh();
		expect(statuses).toEqual([["pi-team", "🤖 1 idle · $0.138"], ["pi-team", "🤖 $0.138"]]);
	});

	it("clears the line for an empty registry with zero spend", () => {
		const registry = new TeamRegistry();
		const { ctx, statuses } = mockContext();
		registry.captureContext(ctx);
		new StatusLine(registry).refresh();
		expect(statuses).toEqual([["pi-team", undefined]]);
	});

	it("does nothing without a captured context", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "running", 0.1));
		expect(() => new StatusLine(registry).refresh()).not.toThrow();
	});

	it("does nothing outside TUI mode", () => {
		const registry = new TeamRegistry();
		registry.add(mate("a", "running", 0.1));
		const { ctx, statuses } = mockContext({ mode: "cli" });
		registry.captureContext(ctx);
		new StatusLine(registry).refresh();
		expect(statuses).toHaveLength(0);
	});

	it("exits before context access once the registry is closed", () => {
		const registry = new TeamRegistry();
		const poisoned = new Proxy({} as object, {
			get() {
				throw new Error("context accessed after close");
			},
		}) as unknown as ExtensionContext;
		registry.captureContext(poisoned);
		registry.close();
		const statusline = new StatusLine(registry);
		expect(() => statusline.refresh()).not.toThrow();
	});
});
