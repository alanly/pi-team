/**
 * Core types for pi-team.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Custom message type for task-completion notifications. */
export const CT_TEAM_NOTIFY = "team-notify";
/** Custom entry type for the registry snapshot (not sent to the LLM). */
export const CT_TEAM_REGISTRY = "pi-team-registry";
/** Custom entry type for a completed deliverable (not sent to the LLM). */
export const CT_TEAM_RESULT = "pi-team-result";

export type TeamMateState = "starting" | "running" | "idle" | "failed";

export type ReportStatus = "success" | "failure" | "blocked";

/** The result data a teammate reports at the end of a task. */
export interface Deliverable {
	/** True when the teammate called report_result. */
	reported: boolean;
	status?: ReportStatus;
	summary?: string;
	data?: unknown;
	artifacts?: string[];
	/** Fallback assistant text, set when reported is false. */
	text?: string;
	capturedAt: number;
}

/** One notable event in the activity ring buffer. */
export interface ActivityEvent {
	ts: number;
	kind: "tool" | "message";
	name: string;
	preview: string;
}

export interface RegistryCounts {
	/** The count includes the starting state. */
	running: number;
	idle: number;
	failed: number;
}

/** Persisted form of one teammate. */
export interface RegistrySnapshotEntry {
	name: string;
	state: TeamMateState;
	task: string;
	deliverable?: Deliverable;
	failureNote?: string;
	cost?: number;
}

export interface RegistrySnapshot {
	teammates: RegistrySnapshotEntry[];
	totalCost?: number;
}

/** The settings.json "piTeam" block, after normalization. */
export interface PiTeamConfig {
	maxTeammates: number;
	/** Overrides the automatic provider-extension detection when not empty. */
	childExtensions: string[];
	livenessIntervalMs: number;
}

// ---------- RPC surface used by TeamMateProcess (injected for tests) ----------

export type PromptDisposition = "started" | "queued" | "handled";
export type QueuedInputDisposition = "handled" | "queued";

/** A narrow view of the RPC event stream. */
export interface TeamMateEvent {
	type: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	message?: unknown;
	willRetry?: boolean;
	steering?: readonly string[];
	followUp?: readonly string[];
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
		cost?: { total?: number };
	};
	[key: string]: unknown;
}

/** The RpcClient methods that TeamMateProcess uses. The real RpcClient satisfies this. */
export interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: TeamMateEvent) => void): () => void;
	prompt(
		message: string,
		images?: unknown[],
		streamingBehavior?: "steer" | "followUp",
	): Promise<PromptDisposition>;
	steer(message: string, images?: unknown[]): Promise<QueuedInputDisposition>;
	followUp(message: string, images?: unknown[]): Promise<QueuedInputDisposition>;
	getState(): Promise<unknown>;
	getSessionStats(): Promise<unknown>;
	getLastAssistantText(): Promise<string | null>;
}

export type AnyExtensionContext = ExtensionContext;
