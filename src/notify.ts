/**
 * Task completion: the notify-and-pull sequence. A short notification enters
 * the parent conversation. The parent pulls the full deliverable later with
 * team_result. A flag on the teammate gives exactly one notification per task.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamMateProcess } from "./process.ts";
import type { TeamRegistry } from "./registry.ts";
import { CT_TEAM_NOTIFY, CT_TEAM_RESULT } from "./types.ts";

/** Track parent activity from agent_start to agent_settled. */
export class ParentActivity {
	busy = false;

	markBusy(): void {
		this.busy = true;
	}

	markIdle(): void {
		this.busy = false;
	}
}

export interface TeamNotifyDeps {
	pi: ExtensionAPI;
	registry: TeamRegistry;
	activity: ParentActivity;
}

/** The notification body. */
export function buildNotificationText(mate: TeamMateProcess): string {
	if (mate.deliverable?.reported) {
		return `🔔 team: "${mate.name}" finished its task (${mate.deliverable.status}). Use team_result to pull the deliverable.`;
	}
	return `🔔 team: "${mate.name}" finished its task. Use team_result to pull the summary.`;
}

export class TeamNotify {
	constructor(private deps: TeamNotifyDeps) {}

	/**
	 * Send one completion notification. Idempotent through the delivered
	 * flag. The result is stored and appended as a custom entry.
	 */
	deliver(mate: TeamMateProcess): void {
		if (this.deps.registry.closed || mate.closed) return;
		if (mate.delivered) return;
		if (mate.state !== "idle") return;
		mate.delivered = true;
		const { pi, registry, activity } = this.deps;
		const deliverable = mate.deliverable;
		const completedAt = Date.now();
		pi.appendEntry(CT_TEAM_RESULT, {
			name: mate.name,
			task: mate.getTask(),
			deliverable,
			completedAt,
		});
		pi.sendMessage(
			{
				customType: CT_TEAM_NOTIFY,
				display: true,
				content: buildNotificationText(mate),
				details: {
					teammate: mate.name,
					status: deliverable?.reported ? deliverable.status : undefined,
					summaryPreview: deliverable?.summary ?? deliverable?.text?.slice(0, 200) ?? "",
					deliveredAt: completedAt,
				},
			},
			{
				triggerTurn: !activity.busy,
				deliverAs: activity.busy ? "nextTurn" : "followUp",
			},
		);
		const ctx = registry.getContext();
		if (ctx && ctx.mode === "tui") {
			ctx.ui.notify(`team "${mate.name}" finished its task`);
		}
	}
}
