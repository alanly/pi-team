/**
 * The five team_* tools. All tools use executionMode "sequential" because
 * they share the registry in memory.
 */

import type { ExtensionAPI, ExtensionContext, RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveModel, resolveThinking } from "./child-args.ts";
import type { TeamNotify } from "./notify.ts";
import { spawnTeamMate, TeamSpawnError, type SpawnTeamMateDeps } from "./process.ts";
import type { TeamMateProcess } from "./process.ts";
import type { TeamRegistry } from "./registry.ts";
import type { StatusLine } from "./statusline.ts";
import type { PiTeamConfig, RpcClientLike } from "./types.ts";

const TEAM_NAMESPACE = { name: "team", description: "Long-lived sub-agent teammates" };

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	structuredContent?: any;
	isError?: boolean;
}

function text(text: string): Array<{ type: "text"; text: string }> {
	return [{ type: "text", text }];
}

function error(message: string, details?: unknown): ToolResult {
	return { content: text(message), details, isError: true };
}

export interface TeamToolsDeps {
	pi: ExtensionAPI;
	registry: TeamRegistry;
	statusline: StatusLine;
	notify: TeamNotify;
	/** Reads the piTeam settings block on first use, after extension loading. */
	getConfig(): PiTeamConfig;
	createClient(options: RpcClientOptions): RpcClientLike;
	writePersona(text: string): Promise<string>;
	removePersona(path: string): Promise<void>;
	resolveCliPath(): string;
	resolveChildExtensions(config: PiTeamConfig): string[];
	reportResultPath: string;
	/** Called after any registry change so the health probe can start or stop. */
	onRegistryChange?(): void;
}

export interface SpawnParams {
	task: string;
	name?: string;
	systemPrompt?: string;
	tools?: string[];
	model?: string;
	thinking?: string;
}

export interface StatusParams {
	teammate?: string;
	detail?: boolean;
}

export interface ResultParams {
	teammate: string;
}

export interface SteerParams {
	teammate: string;
	mode?: "interrupt" | "queue";
	message: string;
}

export interface StopParams {
	teammate?: string;
	all?: boolean;
}

/** The team tool implementations. Tests drive this class with a fake client. */
export class TeamTools {
	constructor(private deps: TeamToolsDeps) {}

	/** Refresh the status line, persist, and keep the health probe timer current. */
	private changed(): void {
		this.deps.statusline.refresh();
		this.deps.registry.persist();
		this.deps.onRegistryChange?.();
	}

	private spawnDeps(): SpawnTeamMateDeps {
		return {
			createClient: this.deps.createClient,
			writePersona: this.deps.writePersona,
			removePersona: this.deps.removePersona,
			resolveCliPath: this.deps.resolveCliPath,
			resolveChildExtensions: this.deps.resolveChildExtensions,
			reportResultPath: this.deps.reportResultPath,
			config: this.deps.getConfig(),
			onChange: () => this.changed(),
			onComplete: (mate) => {
				this.deps.notify.deliver(mate);
				this.changed();
			},
		};
	}

	// ---------- team_spawn ----------

	async spawn(params: SpawnParams, ctx: ExtensionContext): Promise<ToolResult> {
		const { registry, pi } = this.deps;
		const config = this.deps.getConfig();
		const name = params.name?.trim() || registry.nextName();
		if (registry.has(name)) {
			return error(`A teammate named "${name}" already exists. Choose another name or stop the old teammate.`);
		}
		if (registry.size >= config.maxTeammates) {
			return error(`The teammate limit (${config.maxTeammates}) is reached. Stop a teammate first.`);
		}
		const parentModel = ctx.model ?? undefined;
		const model = resolveModel(params.model, parentModel);
		const parentThinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
		const thinking = resolveThinking(params.thinking, parentThinking);
		let mate: TeamMateProcess;
		try {
			mate = await spawnTeamMate(this.spawnDeps(), {
				name,
				task: params.task,
				cwd: ctx.cwd,
				systemPrompt: params.systemPrompt,
				tools: params.tools,
				model,
				thinking,
			});
		} catch (err) {
			const message = err instanceof TeamSpawnError || err instanceof Error ? err.message : String(err);
			return error(message);
		}
		registry.add(mate);
		this.changed();
		const modelLabel = mate.model ?? "(child default)";
		const lines = [
			`Started teammate "${mate.name}" (state: starting, model: ${modelLabel}).`,
			`The extension sends a notification when this teammate reports. Use team_status to check the progress.`,
		];
		return {
			content: text(lines.join("\n")),
			details: { name: mate.name, state: mate.state, model: mate.model, counts: registry.counts() },
		};
	}

	// ---------- team_status ----------

	async status(params: StatusParams): Promise<ToolResult> {
		const { registry } = this.deps;
		let mates: TeamMateProcess[];
		if (params.teammate) {
			const mate = registry.get(params.teammate);
			if (!mate) return error(`No teammate named "${params.teammate}". Use team_status with no argument to list all.`);
			mates = [mate];
		} else {
			mates = registry.all();
		}
		const counts = registry.counts();
		if (mates.length === 0) {
			return {
				content: text("No teammates."),
				details: { counts },
				structuredContent: { counts, teammates: [] },
			};
		}
		const rows = mates.map((mate) => mate.summary());
		const body = rows
			.map((row) => {
				const tool = row.currentTool ? `, tool: ${row.currentTool}` : "";
				return `${row.name}: ${row.state}${tool}, turns: ${row.turns}, queued: ${row.queuedInputs}, result: ${
					row.resultReady ? "ready" : "none"
				}\n  task: ${row.taskPreview}`;
			})
			.join("\n");
		let extra = "";
		if (params.detail) {
			const details: unknown[] = [];
			for (const mate of mates) {
				let liveState: unknown;
				let sessionStats: unknown;
				try {
					[liveState, sessionStats] = await Promise.all([mate.liveState(), mate.liveStats()]);
				} catch (err) {
					liveState = { error: errText(err) };
				}
				details.push({
					name: mate.name,
					task: mate.getTask(),
					activity: mate.getActivity(),
					failureNote: mate.failureNote,
					liveState,
					sessionStats,
				});
			}
			extra = `\n\nDetail:\n${JSON.stringify(details, null, 2)}`;
		}
		return {
			content: text(
				`${body}\nCounts: ${counts.running} running, ${counts.idle} idle, ${counts.failed} failed.${extra}`,
			),
			details: { counts },
			structuredContent: { counts, teammates: rows },
		};
	}

	// ---------- team_result ----------

	async result(params: ResultParams): Promise<ToolResult> {
		const mate = this.deps.registry.get(params.teammate);
		if (!mate) return error(`No teammate named "${params.teammate}".`);
		const row = mate.summary();
		if (mate.state === "starting") {
			return {
				content: text(`The teammate "${mate.name}" is starting. No result exists yet.`),
				details: { name: mate.name, state: mate.state },
				structuredContent: { name: mate.name, state: mate.state, resultReady: false },
			};
		}
		if (mate.state === "running") {
			return {
				content: text(`The teammate "${mate.name}" is still working${row.currentTool ? ` (tool: ${row.currentTool})` : ""}.`),
				details: { name: mate.name, state: mate.state },
				structuredContent: {
					name: mate.name,
					state: mate.state,
					resultReady: false,
					...(row.currentTool ? { currentTool: row.currentTool } : {}),
					lastEventAgeMs: row.lastEventAgeMs,
				},
			};
		}
		// idle or failed
		const deliverable = mate.result();
		if (!deliverable) {
			const activity = mate.getActivity();
			const last = activity.length > 0 ? activity[activity.length - 1] : undefined;
			return {
				content: text(
					[
						`The teammate "${mate.name}" has no deliverable.`,
						mate.failureNote ? `Failure: ${mate.failureNote}` : "",
						last ? `Last activity: ${last.kind} ${last.name}: ${last.preview}` : "",
					]
						.filter((s) => s.length > 0)
						.join("\n"),
				),
				details: { name: mate.name, state: mate.state },
				structuredContent: {
					name: mate.name,
					state: mate.state,
					resultReady: false,
					...(mate.failureNote ? { failureNote: mate.failureNote } : {}),
				},
				isError: mate.state === "failed",
			};
		}
		const data = deliverable.data;
		const structuredContent: Record<string, unknown> = {
			name: mate.name,
			state: mate.state,
			resultReady: true,
			reported: deliverable.reported,
			capturedAt: deliverable.capturedAt,
		};
		if (deliverable.status) structuredContent.status = deliverable.status;
		if (deliverable.summary !== undefined) structuredContent.summary = deliverable.summary;
		if (data !== undefined) structuredContent.data = data;
		if (deliverable.artifacts) structuredContent.artifacts = deliverable.artifacts;
		if (deliverable.text !== undefined) structuredContent.text = deliverable.text;
		const body = deliverable.reported
			? [
					`Deliverable from "${mate.name}" (${deliverable.status}).`,
					`Task: ${mate.getTask()}`,
					`Summary: ${deliverable.summary ?? "(none)"}`,
					data !== undefined ? `Data: ${JSON.stringify(data, null, 2)}` : "",
					deliverable.artifacts?.length ? `Artifacts: ${deliverable.artifacts.join(", ")}` : "",
				]
			: [
					`The teammate "${mate.name}" finished without a report_result call.`,
					`Task: ${mate.getTask()}`,
					`Last assistant text: ${deliverable.text || "(empty)"}`,
				];
		return {
			content: text(body.filter((s) => s.length > 0).join("\n")),
			details: { name: mate.name, state: mate.state },
			structuredContent,
		};
	}

	// ---------- team_steer ----------

	async steer(params: SteerParams, _ctx: ExtensionContext): Promise<ToolResult> {
		const mate = this.deps.registry.get(params.teammate);
		if (!mate) return error(`No teammate named "${params.teammate}".`);
		if (mate.frozen) {
			return error(`The teammate "${mate.name}" is a frozen stub from a previous session. Start a new teammate.`);
		}
		switch (mate.state) {
			case "starting":
				return error(`The teammate "${mate.name}" is starting. Call team_status, then retry.`);
			case "failed":
				return error(`The teammate "${mate.name}" failed. Use team_stop.`);
			case "idle": {
				let disposition: string;
				try {
					disposition = await mate.startTask(params.message);
				} catch (err) {
					return error(`Prompt to "${mate.name}" failed: ${errText(err)}`);
				}
				if (disposition !== "started") return this.dispositionError(mate, "prompt", disposition);
				this.changed();
				return {
					content: text(`Gave the idle teammate "${mate.name}" a new task. The teammate keeps its context.`),
					details: { name: mate.name, state: mate.state },
				};
			}
			case "running": {
				const mode = params.mode ?? "interrupt";
				const action = mode === "queue" ? "followUp" : "steer";
				let disposition: string;
				try {
					disposition = mode === "queue" ? await mate.queue(params.message) : await mate.steer(params.message);
				} catch (err) {
					return error(`${action} to "${mate.name}" failed: ${errText(err)}`);
				}
				if (disposition !== "queued") return this.dispositionError(mate, action, disposition);
				this.deps.registry.persist();
				return {
					content: text(
						mode === "queue"
							? `Queued the message for "${mate.name}". The teammate processes it after the current turn.`
							: `Interrupted "${mate.name}" with the message. The teammate processes it immediately.`,
					),
					details: { name: mate.name, state: mate.state },
				};
			}
			default:
				return error(`The teammate "${mate.name}" is in an unknown state.`);
		}
	}

	private dispositionError(mate: TeamMateProcess, action: string, disposition: string): ToolResult {
		return error(
			`The ${action} command to "${mate.name}" returned "${disposition}", so the child did not accept it. ` +
				`The state is unchanged. Call team_status to check the teammate.`,
		);
	}

	// ---------- team_stop ----------

	async stop(params: StopParams): Promise<ToolResult> {
		const { registry } = this.deps;
		if (!params.teammate && !params.all) {
			return error(`Give a teammate name or set all to true.`);
		}
		if (params.all) {
			const mates = registry.all();
			if (mates.length === 0) return { content: text("No teammates to stop."), details: { counts: registry.counts() } };
			await Promise.all(mates.map((mate) => this.stopOne(mate)));
			for (const mate of mates) registry.remove(mate.name);
			this.changed();
			return {
				content: text(`Stopped ${mates.length} teammate${mates.length === 1 ? "" : "s"}.`),
				details: { counts: registry.counts() },
			};
		}
		const mate = registry.get(params.teammate as string);
		if (!mate) return error(`No teammate named "${params.teammate}".`);
		const wasRunning = mate.state === "running" || mate.state === "starting";
		await this.stopOne(mate);
		registry.remove(mate.name);
		this.changed();
		return {
			content: text(
				`Stopped teammate "${mate.name}".${wasRunning ? " No deliverable will exist for its task." : ""}`,
			),
			details: { counts: registry.counts() },
		};
	}

	private async stopOne(mate: TeamMateProcess): Promise<void> {
		await mate.stop();
		if (mate.personaFile) await this.deps.removePersona(mate.personaFile).catch(() => undefined);
	}
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------- registration ----------

const TeammateRow = Type.Object({
	name: Type.String(),
	state: Type.String(),
	taskPreview: Type.String(),
	currentTool: Type.Optional(Type.String()),
	lastEventAgeMs: Type.Number(),
	turns: Type.Number(),
	tokens: Type.Object({ input: Type.Number(), output: Type.Number() }),
	queuedInputs: Type.Number(),
	ageMs: Type.Number(),
	resultReady: Type.Boolean(),
});

const TeamStatusOutput = Type.Object({
	counts: Type.Object({ running: Type.Number(), idle: Type.Number(), failed: Type.Number() }),
	teammates: Type.Array(TeammateRow),
});

const TeamResultOutput = Type.Object({
	name: Type.String(),
	state: Type.String(),
	resultReady: Type.Boolean(),
	reported: Type.Optional(Type.Boolean()),
	status: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	data: Type.Optional(Type.Any()),
	artifacts: Type.Optional(Type.Array(Type.String())),
	text: Type.Optional(Type.String()),
	capturedAt: Type.Optional(Type.Number()),
	failureNote: Type.Optional(Type.String()),
	currentTool: Type.Optional(Type.String()),
	lastEventAgeMs: Type.Optional(Type.Number()),
});

/** Register the five tools with pi. */
export function registerTools(pi: ExtensionAPI, tools: TeamTools): void {
	pi.registerTool({
		name: "team_spawn",
		label: "Spawn teammate",
		namespace: TEAM_NAMESPACE,
		description:
			"Start a long-lived teammate with a task. Returns immediately. " +
			"The teammate works in the background in this workspace. " +
			"You are notified when it reports. Use team_status to check progress, " +
			"team_steer to steer or give new tasks, and team_stop to stop it.",
		promptSnippet:
			"Start a long-lived background teammate with a task. Returns immediately; you are notified when it reports.",
		promptGuidelines: [
			"After team_spawn, end your turn and do not wait. The teammate works in the background.",
			"Do not poll team_status or team_result in a loop to wait for a teammate to finish.",
			"A team-notify message starts your next turn when a teammate reports. Then call team_result to pull the deliverable.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			task: Type.String({ description: "The task text. Include all context that the teammate needs." }),
			name: Type.Optional(Type.String({ description: "Unique name. Default: teammate-<n>." })),
			systemPrompt: Type.Optional(Type.String({ description: "Optional persona text for the teammate role." })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional tool allowlist. Pass exact tool names only; the child ignores unknown names. " +
						"report_result is always added.",
				}),
			),
			model: Type.Optional(Type.String({ description: "Model override, for example provider/model. Default: parent model." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level override. Default: parent level." })),
		}),
		execute: (callId, params, _signal, _onUpdate, ctx) => tools.spawn(params, ctx),
	});

	pi.registerTool({
		name: "team_status",
		label: "Teammate status",
		namespace: TEAM_NAMESPACE,
		description:
			"Get the state of one teammate, or of all teammates. " +
			"Omit teammate for all. Set detail to true for the activity ring and live RPC data.",
		promptSnippet: "Show the state of one or all teammates (non-blocking).",
		executionMode: "sequential",
		parameters: Type.Object({
			teammate: Type.Optional(Type.String({ description: "Specific teammate; omit = all." })),
			detail: Type.Optional(Type.Boolean({ description: "Add the activity ring and live RPC data." })),
		}),
		outputSchema: TeamStatusOutput,
		execute: (callId, params) => tools.status(params),
	});

	pi.registerTool({
		name: "team_result",
		label: "Pull teammate deliverable",
		namespace: TEAM_NAMESPACE,
		description:
			"Pull the stored deliverable of a teammate. Reads are repeatable and do not delete data. " +
			"If the teammate is running, the tool says that it is still working.",
		promptSnippet: "Pull a teammate's stored deliverable (non-blocking, repeatable).",
		executionMode: "sequential",
		parameters: Type.Object({
			teammate: Type.String({ description: "The teammate name. Required." }),
		}),
		outputSchema: TeamResultOutput,
		execute: (callId, params) => tools.result(params),
	});

	pi.registerTool({
		name: "team_steer",
		label: "Steer teammate",
		namespace: TEAM_NAMESPACE,
		description:
			"Steer a running teammate or give a new task to an idle teammate. " +
			"mode interrupt steers the current turn. mode queue waits for the current turn to end. " +
			"An idle teammate keeps its prior context.",
		promptSnippet: "Steer a running teammate or give an idle teammate a new task.",
		executionMode: "sequential",
		parameters: Type.Object({
			teammate: Type.String({ description: "The teammate name." }),
			message: Type.String({ description: "The steer or new task text." }),
			mode: Type.Optional(
				Type.Union([Type.Literal("interrupt"), Type.Literal("queue")], {
					description: "Default: interrupt.",
				}),
			),
		}),
		execute: (callId, params, _signal, _onUpdate, ctx) => tools.steer(params, ctx),
	});

	pi.registerTool({
		name: "team_stop",
		label: "Stop teammate",
		namespace: TEAM_NAMESPACE,
		description:
			"Stop a teammate and remove it. Give a teammate name or set all to true. " +
			"The client sends SIGTERM, then SIGKILL. The operation is idempotent.",
		promptSnippet: "Stop a teammate by name, or all teammates, and remove it.",
		executionMode: "sequential",
		parameters: Type.Object({
			teammate: Type.Optional(Type.String({ description: "The teammate name." })),
			all: Type.Optional(Type.Boolean({ description: "Stop every teammate in parallel." })),
		}),
		execute: (callId, params) => tools.stop(params),
	});
}
