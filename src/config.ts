/**
 * Configuration: the settings.json "piTeam" block. pi.getSettings() returns
 * the global settings merged with the project settings, so one read covers
 * both scopes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiTeamConfig } from "./types.ts";

export const DEFAULT_MAX_TEAMMATES = 8;
export const DEFAULT_LIVENESS_INTERVAL_MS = 30_000;

export const DEFAULT_CONFIG: PiTeamConfig = {
	maxTeammates: DEFAULT_MAX_TEAMMATES,
	childExtensions: [],
	livenessIntervalMs: DEFAULT_LIVENESS_INTERVAL_MS,
};

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Normalize an untrusted settings block. */
export function normalizeConfig(raw: unknown): PiTeamConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const value = raw as Partial<Record<keyof PiTeamConfig, unknown>>;
	return {
		maxTeammates: positiveInteger(value.maxTeammates, DEFAULT_MAX_TEAMMATES),
		childExtensions: stringArray(value.childExtensions),
		livenessIntervalMs: positiveInteger(value.livenessIntervalMs, DEFAULT_LIVENESS_INTERVAL_MS),
	};
}

/** Read the "piTeam" block from the merged settings. */
export function loadConfig(settings: ReturnType<ExtensionAPI["getSettings"]>): PiTeamConfig {
	return normalizeConfig((settings as Record<string, unknown>).piTeam);
}
