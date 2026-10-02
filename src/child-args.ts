/**
 * Child invocation: command-line arguments, persona composition, model and
 * thinking resolution, and the provider-extension detection.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { PiTeamConfig } from "./types.ts";

/** The autonomous behavior instruction. Appended to every teammate prompt. */
export const AUTONOMY_INSTRUCTION =
	"You are an autonomous teammate. No human answers questions during this task. " +
	"Make reasonable decisions. Note your assumptions and open questions in your report. " +
	"Call report_result when your task is complete. Give the status: success, failure, or blocked. " +
	"Write a summary for your coordinator. Add optional structured data and optional artifact paths. " +
	"This ends your turn. Your coordinator may assign follow-up tasks later. " +
	"Use your prior context for these tasks.";

/** Accepted thinking levels. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** Persona text, then the autonomy instruction. */
export function composeSystemPrompt(persona?: string): string {
	const trimmed = persona?.trim();
	return trimmed ? `${trimmed}\n\n${AUTONOMY_INSTRUCTION}` : AUTONOMY_INSTRUCTION;
}

export interface ChildArgsInput {
	/** Absolute path to src/report-result.ts. */
	reportResultPath: string;
	/** Absolute path to the temporary persona file. */
	personaFile?: string;
	childExtensions?: string[];
	thinking?: string;
	/** Tool allowlist. The function appends report_result. */
	tools?: string[];
}

/**
 * Build the CLI arguments for one child. RpcClient prepends --mode rpc
 * itself. --no-extensions keeps explicit -e paths.
 */
export function buildChildArgs(input: ChildArgsInput): string[] {
	const args: string[] = [
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"-e",
		input.reportResultPath,
	];
	for (const extensionPath of input.childExtensions ?? []) {
		args.push("-e", extensionPath);
	}
	if (input.personaFile) args.push("--append-system-prompt", input.personaFile);
	if (input.thinking) args.push("--thinking", input.thinking);
	if (input.tools && input.tools.length > 0) {
		const tools = input.tools.includes("report_result") ? input.tools : [...input.tools, "report_result"];
		args.push("--tools", tools.join(","));
	}
	return args;
}

/**
 * Extra -e paths for provider extensions. The config value wins when it is
 * not empty. Otherwise the function detects the installed ollama-cloud
 * extension because the parent default provider comes from it.
 */
export function resolveChildExtensions(
	config: Pick<PiTeamConfig, "childExtensions">,
	homeDir: string = os.homedir(),
): string[] {
	if (config.childExtensions.length > 0) return [...config.childExtensions];
	const candidate = path.join(homeDir, ".pi", "agent", "npm", "node_modules", "pi-ollama-cloud", "index.ts");
	return existsSync(candidate) ? [candidate] : [];
}

/** Absolute path to the pi CLI entry point. */
export function resolveCliPath(): string {
	const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
	return path.join(path.dirname(fileURLToPath(resolved)), "cli.js");
}

/** Absolute path to the report_result companion extension. */
export function resolveReportResultPath(): string {
	return fileURLToPath(new URL("./report-result.ts", import.meta.url));
}

/** Split a model override such as "provider/model" or "model". */
export function parseModelOverride(value: string): { provider?: string; id: string } {
	const slash = value.indexOf("/");
	if (slash <= 0) return { id: value };
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/**
 * Resolution order for the child model: the explicit override, then the
 * active parent model. Returns undefined when neither exists.
 */
export function resolveModel(
	override: string | undefined,
	parentModel: Model<any> | undefined,
): { provider?: string; id: string } | undefined {
	if (override && override.trim()) return parseModelOverride(override.trim());
	if (parentModel) return { provider: parentModel.provider, id: parentModel.id };
	return undefined;
}

/** True for a known thinking level. */
export function isValidThinkingLevel(value: string): value is ThinkingLevelName {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolution order for the thinking level: the explicit override, then the
 * parent level. An unknown value passes through unchanged.
 */
export function resolveThinking(override: string | undefined, parentLevel: string | undefined): string | undefined {
	const value = override?.trim() || parentLevel;
	if (!value) return undefined;
	return isValidThinkingLevel(value) ? value : value;
}
