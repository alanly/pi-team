/**
 * TeamMateProcess: the RpcClient wrapper, the event buffer, the state
 * machine, the deliverable capture, and the steer/prompt/stop operations.
 *
 * The RPC client is injected, so tests can drive the state machine with a
 * scripted fake client and no child process.
 */

import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type {
	ActivityEvent,
	Deliverable,
	PiTeamConfig,
	RegistrySnapshotEntry,
	ReportStatus,
	RpcClientLike,
	TeamMateEvent,
	TeamMateState,
} from "./types.ts";
import { buildChildArgs, composeSystemPrompt, mergeChildExtensions } from "./child-args.ts";

/** The activity ring keeps the newest 10 notable events. */
export const ACTIVITY_CAPACITY = 10;
/** Timeout for an ordinary RPC call. */
export const RPC_TIMEOUT_MS = 30_000;
/** Race limit for one health probe. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Limit for one cost reconciliation request. */
export const COST_TIMEOUT_MS = 1_000;
/** Timeout for the stop call (SIGTERM, then SIGKILL after 1 second). */
export const STOP_TIMEOUT_MS = 5_000;
/** Preview length for one activity entry. */
export const PREVIEW_MAX = 120;

/** Race a promise against a timeout. The inner rejection is always handled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "RPC call"): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** True when an RPC error says that the child process exited. */
export function isProcessExitError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Agent process exited/.test(message);
}

/** Text of an agent message, used for activity previews and report fallback. */
export function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { content?: unknown; text?: unknown };
	if (typeof m.text === "string") return m.text;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.map((block) =>
				block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
					? (block as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

function truncate(text: string, max: number = PREVIEW_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function preview(value: unknown, max: number = PREVIEW_MAX): string {
	if (typeof value === "string") return truncate(value, max);
	try {
		return truncate(JSON.stringify(value) ?? "", max);
	} catch {
		return truncate(String(value), max);
	}
}

const REPORT_STATUSES: ReportStatus[] = ["success", "failure", "blocked"];

interface CostMessage {
	role?: string;
	usage?: { cost?: { total?: number } };
}

function validCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function captureDeliverable(args: unknown): Deliverable | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as { status?: unknown; summary?: unknown; data?: unknown; artifacts?: unknown };
	const status = typeof a.status === "string" && (REPORT_STATUSES as string[]).includes(a.status)
		? (a.status as ReportStatus)
		: undefined;
	if (!status) return undefined;
	const artifacts = Array.isArray(a.artifacts) ? a.artifacts.filter((x): x is string => typeof x === "string") : undefined;
	return {
		reported: true,
		status,
		summary: typeof a.summary === "string" ? a.summary : undefined,
		data: a.data,
		artifacts,
		capturedAt: Date.now(),
	};
}

export interface TeamMateInit {
	name: string;
	task: string;
	/** Display string such as "provider/model". */
	model?: string;
	state?: TeamMateState;
	deliverable?: Deliverable;
	frozen?: boolean;
	cost?: number;
	failureNote?: string;
	personaFile?: string;
	client?: RpcClientLike;
	onChange?: (mate: TeamMateProcess) => void;
	onComplete?: (mate: TeamMateProcess) => void;
}

/** One live or frozen teammate. */
export class TeamMateProcess {
	readonly name: string;
	task: string;
	readonly model?: string;
	state: TeamMateState;
	deliverable?: Deliverable;
	failureNote?: string;
	personaFile?: string;
	readonly frozen: boolean;
	readonly createdAt: number;
	lastEventTs: number;

	turns = 0;
	tokensIn = 0;
	tokensOut = 0;
	currentTool?: string;
	queuedInputs = 0;
	delivered = false;

	private client?: RpcClientLike;
	private unsubscribe?: () => void;
	private activity: ActivityEvent[] = [];
	private queueSteering: readonly string[] = [];
	private queueFollowUp: readonly string[] = [];
	private probeFailures = 0;
	private settleToken = 0;
	private assistantCost = 0;
	private additionalCost = 0;
	private costEpoch = 0;
	private isClosed = false;
	private stopPromise?: Promise<void>;
	private taskStartedAt: number;
	private onChange?: (mate: TeamMateProcess) => void;
	private onComplete?: (mate: TeamMateProcess) => void;

	constructor(init: TeamMateInit) {
		this.name = init.name;
		this.task = init.task;
		this.model = init.model;
		this.state = init.state ?? "starting";
		this.deliverable = init.deliverable;
		this.failureNote = init.failureNote;
		this.personaFile = init.personaFile;
		this.frozen = init.frozen ?? false;
		this.additionalCost = validCost(init.cost) ? init.cost : 0;
		this.createdAt = Date.now();
		this.lastEventTs = this.createdAt;
		this.taskStartedAt = this.createdAt;
		this.onChange = init.onChange;
		this.onComplete = init.onComplete;
		if (init.client) this.bind(init.client);
	}

	/** A frozen stub has no live client. */
	static frozenStub(entry: RegistrySnapshotEntry, note?: string): TeamMateProcess {
		const interrupted = entry.state === "running" || entry.state === "starting";
		return new TeamMateProcess({
			name: entry.name,
			task: entry.task,
			state: interrupted ? "failed" : entry.state,
			deliverable: entry.deliverable,
			cost: entry.cost,
			frozen: true,
			failureNote: entry.failureNote ?? (interrupted ? note : undefined),
		});
	}

	/** Attach the client and subscribe to its event stream. */
	bind(client: RpcClientLike): void {
		if (this.closed || this.frozen) return;
		this.client = client;
		this.unsubscribe = client.onEvent((event) => this.handleEvent(event));
	}

	get cost(): number {
		return this.assistantCost + this.additionalCost;
	}

	get closed(): boolean {
		return this.isClosed;
	}

	/** Latest stored deliverable, when one exists. */
	get hasResult(): boolean {
		return this.deliverable !== undefined;
	}

	/** True when a running teammate has no pending queued input. */
	get queueEmpty(): boolean {
		return this.queuedInputs === 0;
	}

	/** The last stored deliverable read of team_result. */
	result(): Deliverable | undefined {
		return this.deliverable;
	}

	/** The activity ring, newest last. */
	getActivity(): ActivityEvent[] {
		return [...this.activity];
	}

	/** The full task text. */
	getTask(): string {
		return this.task;
	}

	// ---------- event handling ----------

	handleEvent(event: TeamMateEvent): void {
		if (this.closed || this.frozen || this.state === "failed") return;
		this.lastEventTs = Date.now();
		switch (event.type) {
			case "agent_start":
				this.state = this.state === "idle" ? "running" : this.state === "starting" ? "running" : this.state;
				this.currentTool = undefined;
				break;
			case "agent_end":
				this.turns++;
				if (event.willRetry) this.state = "running";
				break;
			case "agent_settled":
				void this.settle().catch(() => undefined);
				break;
			case "queue_update": {
				this.queueSteering = event.steering ?? [];
				this.queueFollowUp = event.followUp ?? [];
				this.queuedInputs = this.queueSteering.length + this.queueFollowUp.length;
				break;
			}
			case "tool_execution_start":
				this.currentTool = event.toolName;
				if (event.toolName === "report_result") {
					const captured = captureDeliverable(event.args);
					if (captured) this.deliverable = captured;
				}
				this.pushActivity({ ts: this.lastEventTs, kind: "tool", name: event.toolName ?? "tool", preview: preview(event.args) });
				break;
			case "tool_execution_end":
				if (this.currentTool === event.toolName) this.currentTool = undefined;
				this.pushActivity({
					ts: this.lastEventTs,
					kind: "tool",
					name: event.toolName ?? "tool",
					preview: preview(event.result ?? ""),
				});
				break;
			case "message_end": {
				const message = event.message as CostMessage | null | undefined;
				if (message?.role === "assistant") {
					this.costEpoch++;
					const cost = message.usage?.cost?.total;
					if (validCost(cost)) this.assistantCost += cost;
				}
				this.pushActivity({
					ts: this.lastEventTs,
					kind: "message",
					name: "assistant",
					preview: preview(messageText(event.message)),
				});
				break;
			}
			case "message_update": {
				const usage = event.usage;
				if (usage && typeof usage === "object") {
					if (typeof usage.input === "number") this.tokensIn = usage.input;
					if (typeof usage.output === "number") this.tokensOut = usage.output;
				}
				break;
			}
			default:
				break;
		}
		if (!this.closed) this.onChange?.(this);
	}

	private pushActivity(event: ActivityEvent): void {
		this.activity.push(event);
		if (this.activity.length > ACTIVITY_CAPACITY) this.activity.splice(0, this.activity.length - ACTIVITY_CAPACITY);
	}

	private async settle(): Promise<void> {
		if (this.closed || this.state === "failed" || this.state === "idle") return;
		// A non-empty queue keeps the teammate running. agent_settled should
		// not arrive in that case, but this guard keeps the state correct.
		if (!this.queueEmpty) {
			this.state = "running";
			this.onChange?.(this);
			return;
		}
		const token = ++this.settleToken;
		void this.reconcileCost();
		if (!this.deliverable) {
			let text = "";
			try {
				const client = this.client;
				text = client ? ((await withTimeout(client.getLastAssistantText(), RPC_TIMEOUT_MS, "getLastAssistantText")) ?? "") : "";
			} catch {
				text = "";
			}
			// The state can change during the await: read it fresh.
			const current = this.state as TeamMateState;
			if (this.closed || token !== this.settleToken || current === "failed") return;
			if (current !== "running" && current !== "starting") return;
			this.deliverable = { reported: false, text, capturedAt: Date.now() };
		}
		this.state = "idle";
		this.currentTool = undefined;
		this.onChange?.(this);
		if (!this.closed) this.onComplete?.(this);
	}

	private async reconcileCost(final = false): Promise<void> {
		const client = this.client;
		if (!client || this.frozen || this.state === "failed" || (!final && this.closed)) return;
		const assistantCost = this.assistantCost;
		const epoch = this.costEpoch;
		try {
			const stats = await withTimeout(client.getSessionStats(), COST_TIMEOUT_MS, "getSessionStats");
			if (!final && (this.closed || epoch !== this.costEpoch)) return;
			const cost = (stats as { cost?: unknown } | null | undefined)?.cost;
			if (!validCost(cost)) return;
			const additional = Math.max(this.additionalCost, cost - assistantCost, 0);
			if (additional === this.additionalCost) return;
			this.additionalCost = additional;
			if (!final) this.onChange?.(this);
		} catch {
			// Accounting is best-effort; keep the known lifetime total.
		}
	}

	// ---------- commands ----------

	private assertOpen(): void {
		if (this.closed) throw new Error("team mate is closed");
	}

	private liveClient(): RpcClientLike {
		this.assertOpen();
		if (!this.client) throw new Error("team mate has no live client");
		return this.client;
	}

	private async command<T>(request: Promise<T>, label: string): Promise<T> {
		const reply = await withTimeout(request, RPC_TIMEOUT_MS, label);
		this.assertOpen();
		return reply;
	}

	/** The first prompt of a new teammate. The state stays "starting" until agent_start. */
	async initialPrompt(task: string): Promise<string> {
		const client = this.liveClient();
		this.resetTask(task);
		return this.command(client.prompt(task), "prompt");
	}

	/** A new task for an idle teammate. The state changes to running after "started". */
	async startTask(task: string): Promise<string> {
		const client = this.liveClient();
		this.resetTask(task);
		const disposition = await this.command(client.prompt(task), "prompt");
		this.assertOpen();
		if (disposition === "started") {
			this.state = "running";
			this.onChange?.(this);
		}
		return disposition;
	}

	async steer(message: string): Promise<string> {
		return this.command(this.liveClient().steer(message), "steer");
	}

	async queue(message: string): Promise<string> {
		return this.command(this.liveClient().followUp(message), "followUp");
	}

	/** Reset the per-task data when a new task starts. */
	private resetTask(task: string): void {
		this.task = task;
		this.taskStartedAt = Date.now();
		this.delivered = false;
		this.deliverable = undefined;
		this.activity = [];
		this.settleToken++;
	}

	/** team_stop: stop the child process. Idempotent. */
	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.isClosed = true;
		this.settleToken++;
		this.disposeListener();
		this.stopPromise = this.finalizeStop();
		return this.stopPromise;
	}

	private async finalizeStop(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			if (!this.frozen && this.state !== "failed") await this.reconcileCost(true);
		} finally {
			try {
				await withTimeout(client.stop(), STOP_TIMEOUT_MS, "stop");
			} catch {
				// stop() can leave RPC requests unresolved; termination stays bounded.
			}
		}
	}

	/** Release the event subscription without stopping the child. */
	disposeListener(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	// ---------- health probe ----------

	/**
	 * One health probe. A process exit error sets failed immediately. Two
	 * consecutive other failures set failed. A success resets the count.
	 */
	async probe(): Promise<"alive" | "failed"> {
		if (this.frozen) return "alive";
		if (this.state === "failed") return "failed";
		if (this.closed) return "alive";
		const client = this.client;
		if (!client) return "alive";
		try {
			await withTimeout(client.getState(), PROBE_TIMEOUT_MS, "health probe");
			if (this.closed) return (this.state as TeamMateState) === "failed" ? "failed" : "alive";
			this.probeFailures = 0;
			return "alive";
		} catch (error) {
			if (this.closed) return (this.state as TeamMateState) === "failed" ? "failed" : "alive";
			const message = error instanceof Error ? error.message : String(error);
			if (isProcessExitError(error)) return this.markFailed(message);
			this.probeFailures++;
			if (this.probeFailures >= 2) return this.markFailed(`health probe failed twice: ${message}`);
			return "alive";
		}
	}

	/** Set the failed state, stop the child with a timeout, and ignore stop errors. */
	markFailed(note: string): "failed" {
		if (this.closed || this.state === "failed") return "failed";
		this.state = "failed";
		this.failureNote = note;
		try {
			this.onChange?.(this);
		} finally {
			void this.stop();
		}
		return "failed";
	}

	// ---------- reads ----------

	/** Rows for team_status. */
	summary(): {
		name: string;
		state: TeamMateState;
		taskPreview: string;
		currentTool?: string;
		lastEventAgeMs: number;
		turns: number;
		tokens: { input: number; output: number };
		queuedInputs: number;
		ageMs: number;
		resultReady: boolean;
	} {
		return {
			name: this.name,
			state: this.state,
			taskPreview: truncate(this.task, 80),
			currentTool: this.currentTool,
			lastEventAgeMs: Date.now() - this.lastEventTs,
			turns: this.turns,
			tokens: { input: this.tokensIn, output: this.tokensOut },
			queuedInputs: this.queuedInputs,
			ageMs: Date.now() - this.createdAt,
			resultReady: this.hasResult,
		};
	}

	/** Live RPC state, for team_status with detail. */
	async liveState(): Promise<unknown> {
		if (this.closed || !this.client) return undefined;
		const state = await withTimeout(this.client.getState(), RPC_TIMEOUT_MS, "getState");
		return this.closed ? undefined : state;
	}

	/** Live session stats, for team_status with detail. */
	async liveStats(): Promise<unknown> {
		if (this.closed || !this.client) return undefined;
		const stats = await withTimeout(this.client.getSessionStats(), RPC_TIMEOUT_MS, "getSessionStats");
		return this.closed ? undefined : stats;
	}

	/** Persisted form. */
	snapshotEntry(): RegistrySnapshotEntry {
		return {
			name: this.name,
			state: this.state,
			task: this.task,
			cost: this.cost,
			...(this.deliverable ? { deliverable: this.deliverable } : {}),
			...(this.failureNote ? { failureNote: this.failureNote } : {}),
		};
	}
}

// ---------- spawn factory ----------

export interface SpawnTeamMateDeps {
	createClient(options: RpcClientOptions): RpcClientLike;
	writePersona(text: string): Promise<string>;
	removePersona(path: string): Promise<void>;
	resolveCliPath(): string;
	resolveChildExtensions(config: PiTeamConfig): string[];
	reportResultPath: string;
	config: PiTeamConfig;
	onChange(mate: TeamMateProcess): void;
	onComplete(mate: TeamMateProcess): void;
}

export interface SpawnTeamMateSpec {
	name: string;
	task: string;
	cwd: string;
	systemPrompt?: string;
	tools?: string[];
	/** Extension paths the parent asked to load, in addition to the configured ones. */
	extensions?: string[];
	/** Resolved model, when one exists. */
	model?: { provider?: string; id?: string };
	thinking?: string;
}

/** Error text a spawn failure carries back to the tool. */
export class TeamSpawnError extends Error {}

/** True for -e values that do not name a file, such as builtin:mcp. */
function isSyntheticExtensionPath(value: string): boolean {
	return value.startsWith("builtin:") || value.startsWith("<");
}

/** Resolve provided paths against cwd and reject missing files before the child starts. */
function resolveProvidedExtensions(name: string, cwd: string, provided: string[]): string[] {
	const missing: string[] = [];
	const resolved = provided.map((raw) => {
		if (isSyntheticExtensionPath(raw)) return raw;
		const resolvedPath = path.resolve(cwd, raw);
		if (!existsSync(resolvedPath)) missing.push(raw);
		return resolvedPath;
	});
	if (missing.length > 0) {
		throw new TeamSpawnError(
			`The teammate "${name}" cannot start: extension file(s) not found: ${missing.join(", ")}`,
		);
	}
	return resolved;
}

/**
 * Build the child arguments, start the RpcClient, and send the first
 * prompt. Any failure stops the child and removes the temporary persona
 * file. The caller adds the returned teammate to the registry.
 */
export async function spawnTeamMate(deps: SpawnTeamMateDeps, spec: SpawnTeamMateSpec): Promise<TeamMateProcess> {
	const personaFile = await deps.writePersona(composeSystemPrompt(spec.systemPrompt));
	const providedExtensions = spec.extensions?.length
		? resolveProvidedExtensions(spec.name, spec.cwd, spec.extensions)
		: [];
	const childExtensions = mergeChildExtensions(deps.resolveChildExtensions(deps.config), providedExtensions);
	const args = buildChildArgs({
		reportResultPath: deps.reportResultPath,
		personaFile,
		childExtensions,
		thinking: spec.thinking,
		tools: spec.tools,
	});
	const client = deps.createClient({
		cliPath: deps.resolveCliPath(),
		cwd: spec.cwd,
		env: { PI_TEAMMATE: "1" },
		...(spec.model?.provider ? { provider: spec.model.provider } : {}),
		...(spec.model?.id ? { model: spec.model.id } : {}),
		args,
	});
	const model = spec.model?.id ? `${spec.model.provider ? `${spec.model.provider}/` : ""}${spec.model.id}` : undefined;
	const mate = new TeamMateProcess({
		name: spec.name,
		task: spec.task,
		model,
		personaFile,
		client,
		onChange: deps.onChange,
		onComplete: deps.onComplete,
	});
	const cleanup = async (): Promise<void> => {
		await mate.stop();
		await deps.removePersona(personaFile).catch(() => undefined);
	};
	try {
		await client.start();
	} catch (error) {
		await cleanup();
		const message = error instanceof Error ? error.message : String(error);
		throw new TeamSpawnError(`The teammate "${spec.name}" failed at startup: ${message}`);
	}
	try {
		const disposition = await mate.initialPrompt(spec.task);
		if (disposition !== "started") {
			await cleanup();
			throw new TeamSpawnError(
				`The teammate "${spec.name}" did not start its first task (disposition "${disposition}").`,
			);
		}
	} catch (error) {
		if (error instanceof TeamSpawnError) throw error;
		await cleanup();
		const message = error instanceof Error ? error.message : String(error);
		throw new TeamSpawnError(`The teammate "${spec.name}" failed on its first task: ${message}`);
	}
	return mate;
}

// ---------- liveness poller ----------

/** The registry view the poller needs. Avoids an import cycle with registry.ts. */
export interface LivenessRegistry {
	readonly size: number;
	all(): TeamMateProcess[];
}

export interface LivenessPollerDeps {
	registry: LivenessRegistry;
	/** The probe interval, or a getter that reads the config lazily. */
	intervalMs: number | (() => number);
	onStateChange(): void;
	/** Injectable timer functions for tests. */
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}

/**
 * The health-probe timer. It runs only while the registry is not empty.
 * Each tick probes every teammate in parallel and refreshes the status line.
 */
export class LivenessPoller {
	private timer?: ReturnType<typeof setInterval>;
	private stopped = false;
	private tickToken = 0;
	private readonly setIntervalFn: typeof setInterval;
	private readonly clearIntervalFn: typeof clearInterval;

	constructor(private deps: LivenessPollerDeps) {
		this.setIntervalFn = deps.setInterval ?? setInterval;
		this.clearIntervalFn = deps.clearInterval ?? clearInterval;
	}

	/** Start the timer when needed and stop it when the registry is empty. */
	ensureRunning(): void {
		if (this.deps.registry.size === 0) {
			this.stop();
			return;
		}
		if (this.timer) return;
		this.stopped = false;
		const intervalMs = typeof this.deps.intervalMs === "function" ? this.deps.intervalMs() : this.deps.intervalMs;
		this.timer = this.setIntervalFn(() => void this.tick(), intervalMs);
		// Do not keep the parent process alive for the probe timer.
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** Run one probe round now. */
	async tick(): Promise<void> {
		if (this.stopped) return;
		if (this.deps.registry.size === 0) {
			this.stop();
			return;
		}
		const token = this.tickToken;
		await Promise.all(this.deps.registry.all().map((mate) => mate.probe()));
		if (!this.stopped && token === this.tickToken) this.deps.onStateChange();
	}

	stop(): void {
		this.stopped = true;
		this.tickToken++;
		if (this.timer) {
			this.clearIntervalFn(this.timer);
			this.timer = undefined;
		}
	}
}
