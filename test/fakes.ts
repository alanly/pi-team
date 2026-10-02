/**
 * Test doubles: a scripted RpcClient, a mock extension pi, and a mock
 * extension context.
 */

import type { ExtensionAPI, ExtensionContext, RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { PromptDisposition, QueuedInputDisposition, RpcClientLike, TeamMateEvent } from "../src/types.ts";

export class FakeClient implements RpcClientLike {
	listeners = new Set<(event: TeamMateEvent) => void>();
	started = false;
	stopped = false;
	promptCalls: string[] = [];
	steerCalls: string[] = [];
	followUpCalls: string[] = [];
	promptDisposition: PromptDisposition = "started";
	steerDisposition: QueuedInputDisposition = "queued";
	followUpDisposition: QueuedInputDisposition = "queued";
	startError?: Error;
	stateError?: Error;
	stateResult: unknown = { isStreaming: false };
	statsResult: unknown = { tokens: { input: 1, output: 2 } };
	lastText: string | null = null;

	async start(): Promise<void> {
		if (this.startError) throw this.startError;
		this.started = true;
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	onEvent(listener: (event: TeamMateEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(message: string): Promise<PromptDisposition> {
		this.promptCalls.push(message);
		return this.promptDisposition;
	}

	async steer(message: string): Promise<QueuedInputDisposition> {
		this.steerCalls.push(message);
		return this.steerDisposition;
	}

	async followUp(message: string): Promise<QueuedInputDisposition> {
		this.followUpCalls.push(message);
		return this.followUpDisposition;
	}

	async getState(): Promise<unknown> {
		if (this.stateError) throw this.stateError;
		return this.stateResult;
	}

	async getSessionStats(): Promise<unknown> {
		return this.statsResult;
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.lastText;
	}

	emit(event: TeamMateEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

export interface MockPi {
	pi: ExtensionAPI;
	calls: {
		tools: Array<{ name: string; namespace?: { name: string }; executionMode?: string }>;
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
