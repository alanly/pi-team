/**
 * TeamRegistry: the in-memory map of teammates, the captured extension
 * context, count and cost queries, the appendEntry persistence, and the
 * restore of frozen stubs after a parent restart.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamMateProcess } from "./process.ts";
import type {
	Deliverable,
	RegistryCounts,
	RegistrySnapshot,
	RegistrySnapshotEntry,
} from "./types.ts";
import { CT_TEAM_REGISTRY } from "./types.ts";

export const NAME_PREFIX = "teammate-";

/** Comparison baseline for a session that never wrote a snapshot. */
const EMPTY_SNAPSHOT: RegistrySnapshot = { teammates: [], totalCost: 0 };

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameStringList(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((x, i) => x === b[i]);
}

function sameDeliverable(a: Deliverable | undefined, b: Deliverable | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.reported === b.reported &&
		a.status === b.status &&
		a.summary === b.summary &&
		a.data === b.data &&
		a.text === b.text &&
		a.capturedAt === b.capturedAt &&
		sameStringList(a.artifacts, b.artifacts)
	);
}

function sameSnapshot(a: RegistrySnapshot, b: RegistrySnapshot): boolean {
	if (a.teammates.length !== b.teammates.length) return false;
	if ((a.totalCost ?? 0) !== (b.totalCost ?? 0)) return false;
	return a.teammates.every((x, i) => {
		const y = b.teammates[i] as RegistrySnapshotEntry;
		return (
			x.name === y.name &&
			x.state === y.state &&
			x.task === y.task &&
			(x.cost ?? 0) === (y.cost ?? 0) &&
			x.failureNote === y.failureNote &&
			sameDeliverable(x.deliverable, y.deliverable)
		);
	});
}

export class TeamRegistry {
	private mates = new Map<string, TeamMateProcess>();
	private counter = 0;
	private ctx?: ExtensionContext;
	private pi?: ExtensionAPI;
	private persistQueued = false;
	private persistToken = 0;
	private closedState = false;
	private retiredCost = 0;
	private lastWritten: RegistrySnapshot = EMPTY_SNAPSHOT;

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
		if (this.mates.has(mate.name)) throw new Error(`teammate "${mate.name}" already exists`);
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

	/** Remove an entry; its cost stays in the session total. Idempotent. */
	remove(name: string): TeamMateProcess | undefined {
		const mate = this.mates.get(name);
		if (!mate) return undefined;
		this.mates.delete(name);
		this.retiredCost += mate.cost;
		return mate;
	}

	clear(): void {
		this.mates.clear();
	}

	/** Cumulative child usage: retired teammates plus the live ones. */
	get totalCost(): number {
		let total = this.retiredCost;
		for (const mate of this.mates.values()) total += mate.cost;
		return total;
	}

	/** True after the controlled shutdown began; blocks ordinary persistence. */
	get closed(): boolean {
		return this.closedState;
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
		return { teammates: this.all().map((mate) => mate.snapshotEntry()), totalCost: this.totalCost };
	}

	/**
	 * Append the registry snapshot to the session. Custom entries do not go
	 * to the LLM. Calls in one microtask burst produce one write.
	 */
	persist(): void {
		if (!this.pi || this.closedState || this.persistQueued) return;
		this.persistQueued = true;
		const token = ++this.persistToken;
		queueMicrotask(() => {
			if (!this.persistQueued || this.closedState || token !== this.persistToken) return;
			this.persistQueued = false;
			try {
				this.writeSnapshot();
			} catch {
				// A stale runtime can reject the append; never surface an
				// unhandled rejection from this microtask.
			}
		});
	}

	/** Append immediately, while open. Cancels a queued write. */
	persistNow(): void {
		if (this.closedState) return;
		this.persistQueued = false;
		this.persistToken++;
		this.writeSnapshot();
	}

	/** The controlled final flush: allowed after close, skips unchanged data. */
	persistFinal(): void {
		this.persistQueued = false;
		this.persistToken++;
		this.writeSnapshot();
	}

	/** Close ordinary callbacks: queued writes are cancelled and blocked. */
	close(): void {
		this.closedState = true;
		this.persistQueued = false;
		this.persistToken++;
	}

	private writeSnapshot(): void {
		const pi = this.pi;
		if (!pi) return;
		const snapshot = this.snapshot();
		if (sameSnapshot(snapshot, this.lastWritten)) return;
		pi.appendEntry(CT_TEAM_REGISTRY, snapshot);
		this.lastWritten = snapshot;
	}

	/** Stop every teammate in parallel. The caller removes the entries. */
	async stopAll(): Promise<void> {
		await Promise.all(this.all().map((mate) => mate.stop()));
	}

	/**
	 * Restore a snapshot as frozen stubs. A running or starting entry
	 * becomes failed with the restart note. Entry costs are validated and
	 * deduplicated; the retired spend is inferred from the aggregate. The
	 * comparison baseline is seeded with the stored state, so an unchanged
	 * restore appends nothing while a converted one still persists. The
	 * function returns the new teammates.
	 */
	restore(snapshot: RegistrySnapshot, note: string): TeamMateProcess[] {
		const raw = snapshot && Array.isArray(snapshot.teammates) ? snapshot.teammates : [];
		const accepted: Array<{ entry: RegistrySnapshotEntry; cost: number }> = [];
		const seen = new Set(this.mates.keys());
		for (const entry of raw) {
			if (!entry || typeof entry.name !== "string") continue;
			if (seen.has(entry.name)) continue;
			const cost = isFiniteNonNegative(entry.cost) ? entry.cost : 0;
			seen.add(entry.name);
			accepted.push({ entry, cost });
		}
		const entrySum = accepted.reduce((sum, a) => sum + a.cost, 0);
		const storedTotal = isFiniteNonNegative(snapshot?.totalCost) ? snapshot.totalCost : undefined;
		this.retiredCost = storedTotal === undefined ? 0 : Math.max(0, storedTotal - entrySum);
		const existing = this.all().map((mate) => mate.snapshotEntry());
		const restored: TeamMateProcess[] = [];
		for (const { entry, cost } of accepted) {
			const mate = TeamMateProcess.frozenStub({ ...entry, cost }, note);
			this.add(mate);
			restored.push(mate);
		}
		this.persistQueued = false;
		this.persistToken++;
		this.lastWritten = {
			teammates: [...existing, ...accepted.map(({ entry, cost }) => ({ ...entry, cost }))],
			totalCost: this.totalCost,
		};
		return restored;
	}
}
