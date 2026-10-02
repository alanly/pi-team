import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	AUTONOMY_INSTRUCTION,
	buildChildArgs,
	cliPathFromPackageDir,
	composeSystemPrompt,
	isValidThinkingLevel,
	parseModelOverride,
	resolveChildExtensions,
	resolveCliPath,
	resolveThinking,
} from "../src/child-args.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-team-test-"));
	dirs.push(dir);
	return dir;
}
afterAll(async () => {
	await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("composeSystemPrompt", () => {
	it("returns only the autonomy instruction without a persona", () => {
		expect(composeSystemPrompt()).toBe(AUTONOMY_INSTRUCTION);
	});

	it("puts the persona first", () => {
		const text = composeSystemPrompt("You are a database expert.");
		expect(text.startsWith("You are a database expert.")).toBe(true);
		expect(text).toContain(AUTONOMY_INSTRUCTION);
	});
});

describe("buildChildArgs", () => {
	it("builds the base flags and the report_result extension", () => {
		expect(buildChildArgs({ reportResultPath: "/repo/src/report-result.ts" })).toEqual([
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e",
			"/repo/src/report-result.ts",
		]);
	});

	it("adds child extensions and the persona file", () => {
		const args = buildChildArgs({
			reportResultPath: "/repo/src/report-result.ts",
			personaFile: "/tmp/persona.md",
			childExtensions: ["/ext/a.ts", "/ext/b.ts"],
			thinking: "high",
		});
		expect(args).toContain("/ext/a.ts");
		expect(args).toContain("/ext/b.ts");
		expect(args.slice(args.indexOf("--append-system-prompt"))).toEqual([
			"--append-system-prompt",
			"/tmp/persona.md",
			"--thinking",
			"high",
		]);
	});

	it("appends report_result to the tool allowlist once", () => {
		expect(buildChildArgs({ reportResultPath: "/r.ts", tools: ["read", "bash"] }).slice(-2)).toEqual([
			"--tools",
			"read,bash,report_result",
		]);
		expect(buildChildArgs({ reportResultPath: "/r.ts", tools: ["read", "report_result"] }).slice(-2)).toEqual([
			"--tools",
			"read,report_result",
		]);
	});

	it("omits the tools flag when the list is absent or empty", () => {
		expect(buildChildArgs({ reportResultPath: "/r.ts" })).not.toContain("--tools");
		expect(buildChildArgs({ reportResultPath: "/r.ts", tools: [] })).not.toContain("--tools");
	});
});

describe("resolveChildExtensions", () => {
	it("prefers the configured list", () => {
		expect(resolveChildExtensions({ childExtensions: ["/custom/index.ts"] }, "/home/nobody")).toEqual([
			"/custom/index.ts",
		]);
	});

	it("detects the installed ollama-cloud extension", async () => {
		const home = await tempDir();
		const dir = join(home, ".pi", "agent", "npm", "node_modules", "pi-ollama-cloud");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "index.ts"), "export {};\n");
		expect(resolveChildExtensions({ childExtensions: [] }, home)).toEqual([join(dir, "index.ts")]);
	});

	it("returns an empty list when nothing is installed", async () => {
		const home = await tempDir();
		expect(resolveChildExtensions({ childExtensions: [] }, home)).toEqual([]);
	});
});

describe("cli path resolution", () => {
	it("reads bin.pi from package.json", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "dist", "bundle"), { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }));
		await writeFile(join(dir, "dist", "bundle", "cli.js"), "");
		expect(cliPathFromPackageDir(dir)).toBe(join(dir, "dist", "bundle", "cli.js"));
	});

	it("falls back to dist/cli.js when package.json has no bin", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "dist"), { recursive: true });
		await writeFile(join(dir, "dist", "cli.js"), "");
		expect(cliPathFromPackageDir(dir)).toBe(join(dir, "dist", "cli.js"));
	});

	it("returns undefined when nothing exists", async () => {
		expect(cliPathFromPackageDir(await tempDir())).toBeUndefined();
	});

	it("resolveCliPath finds an existing cli.js", () => {
		// In this checkout node_modules exists, so native resolution would also
		// work. The important part: getPackageDir is tried first and returns a
		// real file even when the extension is installed without its own deps.
		const path = resolveCliPath();
		expect(existsSync(path)).toBe(true);
		expect(path.endsWith("cli.js")).toBe(true);
	});
});

describe("model and thinking resolution", () => {
	it("splits provider/model overrides", () => {
		expect(parseModelOverride("ollama-cloud/glm-5")).toEqual({ provider: "ollama-cloud", id: "glm-5" });
		expect(parseModelOverride("glm-5")).toEqual({ id: "glm-5" });
	});

	it("validates thinking levels", () => {
		expect(isValidThinkingLevel("high")).toBe(true);
		expect(isValidThinkingLevel("nonsense")).toBe(false);
		expect(resolveThinking("nonsense", undefined)).toBe("nonsense");
		expect(resolveThinking(undefined, "low")).toBe("low");
		expect(resolveThinking("high", "low")).toBe("high");
	});
});
