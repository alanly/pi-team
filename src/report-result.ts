/**
 * report_result companion extension.
 *
 * Each child loads this file with -e. The tool ends the teammate turn with
 * terminate: true. The parent reads the arguments from the tool_execution_start
 * event, so the deliverable is not limited by the tool-result size.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const reportResultTool = defineTool({
	name: "report_result",
	label: "Report result",
	description:
		"Report the final result of the current task to your coordinator. " +
		"Use this as your last action. It ends your turn.",
	promptSnippet: "Report the task outcome and end the turn",
	promptGuidelines: [
		"Call report_result when the task is complete. It is your last action.",
		"Give the status: success, failure, or blocked. A blocked status means that a decision or an external input is necessary.",
		"Write a concise summary for your coordinator and note your assumptions.",
		"Add optional structured data and optional artifact paths.",
	],
	parameters: Type.Object({
		status: Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("blocked")], {
			description: "The task outcome.",
		}),
		summary: Type.String({ description: "Concise outcome description for the coordinator." }),
		data: Type.Optional(Type.Any({ description: "Structured JSON payload (findings, metrics)." })),
		artifacts: Type.Optional(Type.Array(Type.String(), { description: "Paths of files produced." })),
	}),
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `Reported: ${params.status}` }],
			details: params,
			terminate: true,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(reportResultTool);
}
