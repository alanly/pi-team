/**
 * Footer status line. The line shows teammate counts and exists only while
 * teammates exist: setStatus(key, undefined) clears the line when the
 * registry is empty.
 */

import type { RegistryCounts } from "./types.ts";
import type { TeamRegistry } from "./registry.ts";

export const STATUS_KEY = "pi-team";

/** The subset of theme colors used for the count segments. */
export type StatusFg = (color: "accent" | "success" | "error", text: string) => string;

/**
 * Pure formatter. Returns undefined when all counts are zero, which clears
 * the status line. Segments with a zero count are omitted. The failed
 * segment appears only when the count is larger than zero.
 */
export function formatStatusLine(counts: RegistryCounts, fg: StatusFg): string | undefined {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(fg("accent", `${counts.running} running`));
	if (counts.idle > 0) parts.push(fg("success", `${counts.idle} idle`));
	if (counts.failed > 0) parts.push(fg("error", `${counts.failed} failed`));
	return parts.length ? `🤖 ${parts.join(" · ")}` : undefined;
}

export class StatusLine {
	constructor(private registry: TeamRegistry) {}

	/** Recompute the line after each change of the registry. */
	refresh(): void {
		const ctx = this.registry.getContext();
		// Mode safety: no setStatus when the session has no TUI.
		if (!ctx || ctx.mode !== "tui") return;
		const line = formatStatusLine(this.registry.counts(), (color, text) => ctx.ui.theme.fg(color, text));
		ctx.ui.setStatus(STATUS_KEY, line);
	}
}
