import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../src/config.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("normalizeConfig", () => {
	it("returns the defaults for missing or bad input", () => {
		expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig("nope")).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig({ maxTeammates: -1, livenessIntervalMs: 0, childExtensions: "x" })).toEqual(
			DEFAULT_CONFIG,
		);
	});

	it("keeps valid values", () => {
		expect(
			normalizeConfig({
				maxTeammates: 3,
				livenessIntervalMs: 1000,
				childExtensions: ["/a/index.ts", "", 5, "/b/index.ts"],
			}),
		).toEqual({ maxTeammates: 3, livenessIntervalMs: 1000, childExtensions: ["/a/index.ts", "/b/index.ts"] });
	});
});

describe("loadConfig", () => {
	it("reads the piTeam block from the merged settings", () => {
		const settings = { piTeam: { maxTeammates: 2 } } as unknown as ReturnType<ExtensionAPI["getSettings"]>;
		expect(loadConfig(settings)).toEqual({ ...DEFAULT_CONFIG, maxTeammates: 2 });
	});

	it("returns the defaults when the block is absent", () => {
		expect(loadConfig({} as ReturnType<ExtensionAPI["getSettings"]>)).toEqual(DEFAULT_CONFIG);
	});
});
