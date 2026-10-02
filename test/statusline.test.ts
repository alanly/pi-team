import { describe, expect, it } from "vitest";
import { formatStatusLine } from "../src/statusline.ts";

const identity = (_color: string, text: string) => text;

describe("formatStatusLine", () => {
	it("shows running only", () => {
		expect(formatStatusLine({ running: 1, idle: 0, failed: 0 }, identity)).toBe("🤖 1 running");
		expect(formatStatusLine({ running: 3, idle: 0, failed: 0 }, identity)).toBe("🤖 3 running");
	});

	it("joins all segments with ' · '", () => {
		expect(formatStatusLine({ running: 2, idle: 1, failed: 0 }, identity)).toBe("🤖 2 running · 1 idle");
		expect(formatStatusLine({ running: 2, idle: 1, failed: 1 }, identity)).toBe(
			"🤖 2 running · 1 idle · 1 failed",
		);
	});

	it("omits each zero segment", () => {
		expect(formatStatusLine({ running: 0, idle: 1, failed: 0 }, identity)).toBe("🤖 1 idle");
		expect(formatStatusLine({ running: 1, idle: 0, failed: 2 }, identity)).toBe("🤖 1 running · 2 failed");
		expect(formatStatusLine({ running: 0, idle: 1, failed: 2 }, identity)).toBe("🤖 1 idle · 2 failed");
	});

	it("shows failed only when the count is larger than zero", () => {
		expect(formatStatusLine({ running: 0, idle: 0, failed: 1 }, identity)).toBe("🤖 1 failed");
	});

	it("returns undefined when all counts are zero", () => {
		expect(formatStatusLine({ running: 0, idle: 0, failed: 0 }, identity)).toBeUndefined();
	});

	it("passes theme colors per segment", () => {
		const seen: Array<[string, string]> = [];
		const fg = (color: string, text: string) => {
			seen.push([color, text]);
			return text;
		};
		formatStatusLine({ running: 1, idle: 1, failed: 1 }, fg);
		expect(seen).toEqual([
			["accent", "1 running"],
			["success", "1 idle"],
			["error", "1 failed"],
		]);
	});
});
