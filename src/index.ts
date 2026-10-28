/**
 * pi-team — long-lived sub-agent teammates.
 *
 * Entry point. The factory wires the registry, the status line, the
 * completion notifications, the health probe, the five team_* tools, the
 * notification renderer, and the session lifecycle handlers.
 *
 * Lifecycle rules: the factory starts no process and no timer. Processes
 * start only in tool execute(). session_shutdown stops all teammates in
 * parallel and is idempotent.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	RpcClient,
	type ExtensionAPI,
	type ExtensionContext,
	type RpcClientOptions,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveChildExtensions, resolveCliPath, resolveReportResultPath } from "./child-args.ts";
import { loadConfig } from "./config.ts";
import { ParentActivity, TeamNotify } from "./notify.ts";
import { LivenessPoller } from "./process.ts";
import { TeamRegistry } from "./registry.ts";
import { StatusLine, STATUS_KEY } from "./statusline.ts";
import { registerTools, TeamTools } from "./tools.ts";
import {
	CT_TEAM_NOTIFY,
	CT_TEAM_REGISTRY,
	type PiTeamConfig,
	type RegistrySnapshot,
	type RpcClientLike,
} from "./types.ts";

interface TeamNotifyDetails {
	teammate: string;
	status?: string;
	summaryPreview?: string;
	deliveredAt: number;
}

/** Overrides for tests. Production uses the defaults. */
export interface TeamExtensionOverrides {
	config?: PiTeamConfig;
	createClient?(options: RpcClientOptions): RpcClientLike;
	writePersona?(text: string): Promise<string>;
	removePersona?(path: string): Promise<void>;
	resolveCliPath?(): string;
	resolveChildExtensions?(config: PiTeamConfig): string[];
	reportResultPath?: string;
}

/** The wired extension objects, returned for tests. */
export interface TeamExtension {
	registry: TeamRegistry;
	statusline: StatusLine;
	notify: TeamNotify;
	tools: TeamTools;
	poller: LivenessPoller;
	/** True when the PI_TEAMMATE guard disabled the extension. */
	disabled: boolean;
}

/** Write the persona and autonomy instruction to a temporary file. */
async function writePersonaFile(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-team-persona-"));
	const file = join(dir, "system-prompt.md");
	await writeFile(file, text, "utf8");
	return file;
}

/** Remove a temporary persona file and its directory. */
async function removePersonaFile(file: string): Promise<void> {
	await rm(dirname(file), { recursive: true, force: true });
}

/** The restart note for a session_start reason. */
export function restoreNote(reason: SessionStartEvent["reason"]): string {
	switch (reason) {
		case "reload":
			return "parent session reloaded";
		case "resume":
			return "parent session resumed";
		case "fork":
			return "forked session";
		default:
			return "parent session restarted";
	}
}

/** Read the newest registry snapshot from the session entries. */
export function readLatestSnapshot(ctx: ExtensionContext): RegistrySnapshot | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && (entry as { customType?: string }).customType === CT_TEAM_REGISTRY) {
			const data = (entry as { data?: RegistrySnapshot }).data;
			return { ...data, teammates: Array.isArray(data?.teammates) ? data.teammates : [] };
		}
	}
	return undefined;
}

/** Wire the extension. The factory starts no process and no timer. */
export function createTeamExtension(pi: ExtensionAPI, overrides: TeamExtensionOverrides = {}): TeamExtension {
	// pi.getSettings() is an action method: it is not available during
	// extension loading. Read the config on first use instead.
	let config = overrides.config;
	const getConfig = (): PiTeamConfig => (config ??= loadConfig(pi.getSettings()));
	const registry = new TeamRegistry(pi);
	const statusline = new StatusLine(registry);
	const activity = new ParentActivity();
	const notify = new TeamNotify({ pi, registry, activity });
	const poller = new LivenessPoller({
		registry,
		intervalMs: () => getConfig().livenessIntervalMs,
		onStateChange: () => {
			if (registry.closed) return;
			statusline.refresh();
			registry.persist();
		},
	});
	const tools = new TeamTools({
		pi,
		registry,
		statusline,
		notify,
		getConfig,
		createClient: overrides.createClient ?? ((options: RpcClientOptions) => new RpcClient(options)),
		writePersona: overrides.writePersona ?? writePersonaFile,
		removePersona: overrides.removePersona ?? removePersonaFile,
		resolveCliPath: overrides.resolveCliPath ?? resolveCliPath,
		resolveChildExtensions: overrides.resolveChildExtensions ?? resolveChildExtensions,
		reportResultPath: overrides.reportResultPath ?? resolveReportResultPath(),
		onRegistryChange: () => {
			if (!registry.closed) poller.ensureRunning();
		},
	});

	// Recursion guard: the child environment sets PI_TEAMMATE=1.
	if (process.env.PI_TEAMMATE === "1") {
		return { registry, statusline, notify, tools, poller, disabled: true };
	}

	registerTools(pi, tools);

	// Compact renderer for the completion notification.
	pi.registerMessageRenderer<TeamNotifyDetails>(CT_TEAM_NOTIFY, (message, _options, theme) => {
		const details = (message.details ?? {}) as TeamNotifyDetails;
		const name = theme.fg("accent", details.teammate ?? "teammate");
		const status = details.status
			? " " +
				theme.fg(
					details.status === "success" ? "success" : details.status === "failure" ? "error" : "warning",
					`(${details.status})`,
				)
			: "";
		const preview = details.summaryPreview ? theme.fg("dim", ` ${details.summaryPreview}`) : "";
		return new Text(`🔔 team ${name}${status}${preview}`, 0, 0);
	});

	let shutdownPromise: Promise<void> | undefined;

	pi.on("session_start", async (event, ctx) => {
		if (registry.closed) return;
		registry.captureContext(ctx);
		const snapshot = readLatestSnapshot(ctx);
		if (snapshot) {
			registry.restore(snapshot, restoreNote(event.reason));
			registry.persistNow();
		}
		statusline.refresh();
		poller.ensureRunning();
	});

	pi.on("agent_start", async () => {
		if (!registry.closed) activity.markBusy();
	});
	pi.on("agent_settled", async () => {
		if (!registry.closed) activity.markIdle();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (shutdownPromise) return shutdownPromise;
		registry.close();
		poller.stop();
		const mates = registry.all();
		shutdownPromise = (async () => {
			try {
				await registry.stopAll();
				await Promise.all(mates.map(async (mate) => {
					if (mate.personaFile) await (overrides.removePersona ?? removePersonaFile)(mate.personaFile).catch(() => undefined);
				}));
				registry.persistFinal();
			} finally {
				registry.clear();
				if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		})();
		return shutdownPromise;
	});

	return { registry, statusline, notify, tools, poller, disabled: false };
}

export default function (pi: ExtensionAPI): void {
	createTeamExtension(pi);
}
