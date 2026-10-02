/**
 * TeamRegistry: the in-memory map of teammates, the captured extension
 * context, count queries, the appendEntry persistence, and the restore of
 * frozen stubs after a parent restart.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamMateProcess } from "./process.ts";
import type { RegistryCounts, RegistrySnapshot, RegistrySnapshotEntry } from "./types.ts";
import { CT_TEAM_REGISTRY } from "./types.ts";

export const NAME_PREFIX = "teammate-";

export class TeamRegistry {
	private mates = new Map<string, TeamMateProcess>();
	private counter = 0;
	private ctx?: ExtensionContext;
	private pi?: ExtensionAPI;
	private persistQueued = false;

	constructor(pi?: ExtensionAPI) {
		this.pi = pi;
	}

	/** Capture (or refresh) the extension context. */
	captureContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	getContext(): ExtensionContext | undefined {
		return this.ctx;
	}

	has(name: string): boolean {
		return this.mates.has(name);
	}

	add(mate: TeamMateProcess): void {
		this.mates.set(mate.name, mate);
	}

	get(name: string): TeamMateProcess | undefined {
		return this.mates.get(name);
	}

	all(): TeamMateProcess[] {
		return [...this.mates.values()];
	}

	get size(): number {
		return this.mates.size;
	}

	remove(name: string): TeamMateProcess | undefined {
		const mate = this.mates.get(name);
		if (mate) this.mates.delete(name);
		return mate;
	}

	clear(): void {
		this.mates.clear();
	}

	/** A unique default name: teammate-1, teammate-2, ... */
	nextName(): string {
		let candidate = `${NAME_PREFIX}${++this.counter}`;
		while (this.mates.has(candidate)) candidate = `${NAME_PREFIX}${++this.counter}`;
		return candidate;
	}

	/** The running count includes starting. */
	counts(): RegistryCounts {
		let running = 0;
		let idle = 0;
		let failed = 0;
		for (const mate of this.mates.values()) {
			if (mate.state === "starting" || mate.state === "running") running++;
			else if (mate.state === "idle") idle++;
			else failed++;
		}
		return { running, idle, failed };
	}

	snapshot(): RegistrySnapshot {
		return { teammates: this.all().map((mate) => mate.snapshotEntry()) };
	}

	/**
	 * Append the registry snapshot to the session. Custom entries do not go
	 * to the LLM. Calls in one microtask burst produce one write.
	 */
	persist(): void {
		if (!this.pi || this.persistQueued) return;
		this.persistQueued = true;
		queueMicrotask(() => {
			this.persistQueued = false;
			this.pi?.appendEntry(CT_TEAM_REGISTRY, this.snapshot());
		});
	}

	/** Append immediately. Used by tests. */
	persistNow(): void {
		this.persistQueued = false;
		this.pi?.appendEntry(CT_TEAM_REGISTRY, this.snapshot());
	}

	/** Stop every teammate in parallel. The caller removes the entries. */
	async stopAll(): Promise<void> {
		await Promise.all(this.all().map((mate) => mate.stop()));
	}

	/**
	 * Restore entries as frozen stubs. A running or starting entry becomes
	 * failed with the restart note. The function returns the new teammates.
	 */
	restore(entries: RegistrySnapshotEntry[], note: string): TeamMateProcess[] {
		const restored: TeamMateProcess[] = [];
		for (const entry of entries) {
			if (!entry || typeof entry.name !== "string" || this.mates.has(entry.name)) continue;
			const mate = TeamMateProcess.frozenStub(entry, note);
			this.add(mate);
			restored.push(mate);
		}
		return restored;
	}
}
