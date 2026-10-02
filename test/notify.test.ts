import { describe, expect, it } from "vitest";
import { ParentActivity, TeamNotify, buildNotificationText } from "../src/notify.ts";
import { TeamMateProcess, type TeamMateInit } from "../src/process.ts";
import { TeamRegistry } from "../src/registry.ts";
import { CT_TEAM_NOTIFY, CT_TEAM_RESULT } from "../src/types.ts";
import { mockContext, mockPi } from "./fakes.ts";

function idleMate(overrides: Partial<TeamMateInit> = {}) {
	return new TeamMateProcess({
		name: "alpha",
		task: "the task",
		state: "idle",
		deliverable: { reported: true, status: "success", summary: "all done", capturedAt: 1 },
		...overrides,
	});
}

function setup(busy = false) {
	const { pi, calls } = mockPi();
	const registry = new TeamRegistry(pi);
	const activity = new ParentActivity();
	activity.busy = busy;
	const { ctx, notifications, statuses } = mockContext();
	registry.captureContext(ctx);
	const notify = new TeamNotify({ pi, registry, activity });
	return { pi, calls, registry, notify, activity, notifications, statuses };
}

describe("buildNotificationText", () => {
	it("names the status of a reported result", () => {
		expect(buildNotificationText(idleMate())).toContain("(success)");
	});

	it("uses the summary wording for a fallback result", () => {
		const mate = new TeamMateProcess({
			name: "alpha",
			task: "t",
			state: "idle",
			deliverable: { reported: false, text: "hi", capturedAt: 1 },
		});
		expect(buildNotificationText(mate)).toContain("pull the summary");
	});
});

describe("TeamNotify", () => {
	it("appends the result entry and sends one notification", () => {
		const { notify, calls, registry } = setup();
		const mate = idleMate();
		registry.add(mate);
		notify.deliver(mate);
		expect(mate.delivered).toBe(true);
		expect(calls.entries).toHaveLength(1);
		expect(calls.entries[0]?.[0]).toBe(CT_TEAM_RESULT);
		expect(calls.messages).toHaveLength(1);
		const [message, options] = calls.messages[0] as [Record<string, unknown>, Record<string, unknown>];
		expect(message.customType).toBe(CT_TEAM_NOTIFY);
		expect(options.triggerTurn).toBe(true);
		expect(options.deliverAs).toBe("followUp");
	});

	it("is idempotent for one task", () => {
		const { notify, calls, registry } = setup();
		const mate = idleMate();
		registry.add(mate);
		notify.deliver(mate);
		notify.deliver(mate);
		expect(calls.messages).toHaveLength(1);
	});

	it("waits for the next parent turn when the parent is busy", () => {
		const { notify, calls, registry } = setup(true);
		const mate = idleMate();
		registry.add(mate);
		notify.deliver(mate);
		const [, options] = calls.messages[0] as [unknown, Record<string, unknown>];
		expect(options.triggerTurn).toBe(false);
		expect(options.deliverAs).toBe("nextTurn");
	});

	it("ignores a teammate that is not idle", () => {
		const { notify, calls, registry } = setup();
		const mate = new TeamMateProcess({ name: "alpha", task: "t", state: "running" });
		registry.add(mate);
		notify.deliver(mate);
		expect(calls.messages).toHaveLength(0);
	});

	it("notifies the human user in TUI mode", () => {
		const { notify, registry, notifications } = setup();
		const mate = idleMate();
		registry.add(mate);
		notify.deliver(mate);
		expect(notifications).toContain('team "alpha" finished its task');
	});
});
