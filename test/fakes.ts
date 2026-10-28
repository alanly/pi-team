/**
 * Test doubles: a scripted RpcClient, a mock extension pi, and a mock
 * extension context.
 */

import type { ExtensionAPI, ExtensionContext, RpcClientOptions } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import type { PromptDisposition, QueuedInputDisposition, RpcClientLike, TeamMateEvent } from "../src/types.ts";

export function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function assistantMessage(cost = 0, text = "Done."): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: 123,
	};
}

export class FakeClient implements RpcClientLike {
	listeners = new Set<(event: TeamMateEvent) => void>();
	started = false;
	stopped = false;
	stopCalls = 0;
	statsCalls = 0;
	callOrder: string[] = [];
	stopResponse?: Promise<void>;
	promptResponse?: Promise<PromptDisposition>;
	steerResponse?: Promise<QueuedInputDisposition>;
	followUpResponse?: Promise<QueuedInputDisposition>;
	stateResponse?: Promise<unknown>;
	statsResponse?: Promise<unknown>;
	lastTextResponse?: Promise<string | null>;
	promptCalls: string[] = [];
	steerCalls: string[] = [];
	followUpCalls: string[] = [];
	promptDisposition: PromptDisposition = "started";
	steerDisposition: QueuedInputDisposition = "queued";
	followUpDisposition: QueuedInputDisposition = "queued";
	startError?: Error;
	stateError?: Error;
	stateResult: unknown = { isStreaming: false };
	statsResult: unknown = { tokens: { input: 1, output: 2 }, cost: 0 };
	lastText: string | null = null;

	async start(): Promise<void> {
		if (this.startError) throw this.startError;
		this.started = true;
	}

	async stop(): Promise<void> {
		this.callOrder.push("stop");
		this.stopCalls++;
		this.stopped = true;
		return this.stopResponse;
	}

	onEvent(listener: (event: TeamMateEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.callOrder.push("unsubscribe");
			this.listeners.delete(listener);
		};
	}

	async prompt(message: string): Promise<PromptDisposition> {
		this.promptCalls.push(message);
		return this.promptResponse ?? this.promptDisposition;
	}

	async steer(message: string): Promise<QueuedInputDisposition> {
		this.steerCalls.push(message);
		return this.steerResponse ?? this.steerDisposition;
	}

	async followUp(message: string): Promise<QueuedInputDisposition> {
		this.followUpCalls.push(message);
		return this.followUpResponse ?? this.followUpDisposition;
	}

	async getState(): Promise<unknown> {
		if (this.stateError) throw this.stateError;
		return this.stateResponse ?? this.stateResult;
	}

	async getSessionStats(): Promise<unknown> {
		this.callOrder.push("stats");
		this.statsCalls++;
		return this.statsResponse ?? this.statsResult;
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.lastTextResponse ?? this.lastText;
	}

	emit(event: TeamMateEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

export interface MockPi {
	pi: ExtensionAPI;
	calls: {
		tools: Array<{ name: string; namespace?: { name: string }; executionMode?: string; parameters?: unknown }>;
		renderers: Array<[string, unknown]>;
		events: Array<[string, unknown]>;
		messages: unknown[][];
		entries: unknown[][];
	};
}

export function mockPi(settings: unknown = {}): MockPi {
	const calls: MockPi["calls"] = { tools: [], renderers: [], events: [], messages: [], entries: [] };
	const pi = {
		registerTool: vi.fn((tool: { name: string }) => {
			calls.tools.push(tool as MockPi["calls"]["tools"][number]);
		}),
		registerMessageRenderer: vi.fn((customType: string, renderer: unknown) => {
			calls.renderers.push([customType, renderer]);
		}),
		on: vi.fn((event: string, handler: unknown) => {
			calls.events.push([event, handler]);
		}),
		sendMessage: vi.fn((...args: unknown[]) => {
			calls.messages.push(args);
		}),
		appendEntry: vi.fn((...args: unknown[]) => {
			calls.entries.push(args);
		}),
		getSettings: vi.fn(() => settings),
		getThinkingLevel: vi.fn(() => "high"),
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

export interface MockContext {
	ctx: ExtensionContext;
	statuses: Array<[string, string | undefined]>;
	notifications: string[];
	entries: unknown[];
}

export function mockContext(overrides: Record<string, unknown> = {}): MockContext {
	const statuses: MockContext["statuses"] = [];
	const notifications: string[] = [];
	const entries: unknown[] = [];
	const ctx = {
		cwd: "/tmp/work",
		model: undefined,
		thinkingLevel: "high",
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			notify: (message: string) => notifications.push(message),
		},
		sessionManager: { getEntries: () => entries },
		...overrides,
	} as unknown as ExtensionContext;
	return { ctx, statuses, notifications, entries };
}

/** A createClient factory that serves a known FakeClient. */
export function clientFactory(client: FakeClient): (options: RpcClientOptions) => RpcClientLike {
	return () => client;
}
