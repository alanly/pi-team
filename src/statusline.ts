/**
 * Footer status line. The line shows the teammate counts followed by the
 * cumulative cost, and exists only while teammates exist or spend was
 * retained: setStatus(key, undefined) clears the line otherwise.
 */

import type { RegistryCounts } from "./types.ts";
import type { TeamRegistry } from "./registry.ts";

export const STATUS_KEY = "pi-team";

/** The subset of theme colors used for the status segments. */
export type StatusFg = (color: "accent" | "success" | "error" | "dim", text: string) => string;

/**
 * Pure formatter. Count segments with a zero count are omitted. The cost
 * segment uses three decimals and appears whenever teammates exist, or
 * alone while the unrounded total stays positive. Returns undefined when
 * there is nothing to show, which clears the status line.
 */
export function formatStatusLine(counts: RegistryCounts, totalCost: number, fg: StatusFg): string | undefined {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(fg("accent", `${counts.running} running`));
	if (counts.idle > 0) parts.push(fg("success", `${counts.idle} idle`));
	if (counts.failed > 0) parts.push(fg("error", `${counts.failed} failed`));
	if (parts.length > 0 || totalCost > 0) parts.push(fg("dim", `$${totalCost.toFixed(3)}`));
	return parts.length ? `🤖 ${parts.join(" · ")}` : undefined;
}

export class StatusLine {
	constructor(private registry: TeamRegistry) {}

	/** Recompute the line after each change of the registry. */
	refresh(): void {
		// Exit before touching the context once the runtime is closed.
		if (this.registry.closed) return;
		const ctx = this.registry.getContext();
		// Mode safety: no setStatus when the session has no TUI.
		if (!ctx || ctx.mode !== "tui") return;
		const line = formatStatusLine(
			this.registry.counts(),
			this.registry.totalCost,
			(color, text) => ctx.ui.theme.fg(color, text),
		);
		ctx.ui.setStatus(STATUS_KEY, line);
	}
}
