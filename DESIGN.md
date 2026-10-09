# Technical design: pi-team

**Status:** The design is complete. No code exists.
**Target:** Pi 1.0.0 (`@earendil-works/pi-coding-agent`).
**Repository:** `~/src/github.com/alanly/pi-team`

## Summary

Pi-team is a Pi extension. The extension lets the main agent start sub-agents. The sub-agents are "teammates". The main agent gives tasks to teammates. It monitors their progress. It steers them during a task. It receives their deliverables as events. It stops them when it decides. Only the main agent interacts with teammates. The human user does not interact with a teammate directly.

A status line shows teammate counts. The line starts with the 🤖 emoji. The line appears only when teammates exist.

## Abbreviations and terms

### Abbreviations

| Abbreviation | Meaning |
|---|---|
| API | application programming interface |
| CLI | command-line interface |
| LLM | large language model |
| RPC | remote procedure call |
| TDD | test-driven development |
| TUI | terminal user interface |
| v1 | version 1, the first release of this extension |

### Terms

| Term | Definition |
|---|---|
| parent | the main pi session that runs the pi-team extension |
| child | the pi process that the extension starts for one teammate |
| teammate | a child process that works on tasks for the parent agent |
| deliverable | the result data that a teammate reports at the end of a task |
| persona | optional system prompt text that gives a teammate a role |
| turn | one complete model exchange. The turn starts with an input and ends after the final model output. |
| disposition | the response of the child to a prompt, steer, or followUp command. prompt returns "started", "queued", or "handled". steer and followUp return "queued" or "handled". |
| status line | a text line at the bottom of the TUI. Pi shows the status lines that extensions set. |
| notify-and-pull | the delivery mode of this extension. A short notification enters the parent conversation. The parent reads the full deliverable later with a tool. |
| health probe | a periodic `getState()` request that checks that a teammate is alive |
| registry | the in-memory map of teammates that the extension keeps |
| stuck | a teammate is alive but does not make progress |
| idempotent | an operation that gives the same result after two or more executions |
| ring buffer | a fixed-size buffer that keeps the newest items and discards the oldest items |
| frozen stub | a registry entry without a live process. The entry holds stored data only. |
| allowlist | a list that permits only the named items |
| orphan process | a child process that continues to run after its parent process stops |
| smoke test | a test that verifies that the basic functions operate |

## 1. Purpose and requirements

### 1.1 Requirements and design items

| Requirement | Design item |
|---|---|
| Only the main agent shall interact with the sub-agents. | No teammate interface for the human user exists in v1. All teammate data flows through parent tools. Children run in RPC mode without a user interface. The autonomy instruction tells the model this. (§5.3) |
| The main agent shall start a sub-agent with an arbitrarily defined task. | The `team_spawn` tool takes the task text and an optional persona. No profile files exist. (§5, §8.1) |
| The main agent shall monitor the progress of each sub-agent asynchronously. The main agent shall inspect the progress at any point. | The extension buffers the live RPC event stream for each teammate. The `team_status` tool gives a snapshot. (§6, §8.2) |
| A sub-agent shall communicate its deliverable back to the main agent via an event. | The `report_result` tool in the child reports the deliverable. The parent captures the tool arguments from the RPC event stream. A notification enters the parent conversation. The parent pulls the full deliverable with `team_result`. (§4, §7) |
| The main agent shall stop a sub-agent at any time. The main agent shall give additional tasks to an idle sub-agent. | Teammates are long-lived. After a task, a teammate becomes idle and stays alive. `team_stop` stops it. `team_steer` gives a new task. (§3, §8.4, §8.5) |
| The main agent shall steer a sub-agent whenever necessary. | The `team_steer` tool supports interrupt mode and queue mode. (§8.4) |
| A status line shall appear only when sub-agents exist. The line shall show the count of running sub-agents and the count of idle sub-agents. The line shall start with the 🤖 emoji. | The extension calls `ctx.ui.setStatus("pi-team", text)`. It passes undefined when the registry is empty. The line also shows failed counts when the count is larger than zero. See user decision 4. (§9) |

### 1.2 Confirmed user decisions (October 2026)

1. **Result delivery: notify and pull.** A short notification enters the parent conversation when a teammate completes a task. The parent pulls the full deliverable with `team_result` when it needs the data. If the parent is not busy, the notification starts a new parent turn.

2. **Teammate definition: task and optional persona, all inline.** No profile files exist. Each spawn call contains the task and optional name, system prompt, tools, and model.

3. **Idle policy: until stopped or session end.** An idle teammate continues to run until `team_stop` stops it or the session ends. An idle child process sends no model requests. It uses no tokens.

4. **Status line: failures are visible.** The line shows "· N failed" when N is larger than zero. The parent always sees a failed teammate.

## 2. Architecture

One Pi extension. Single-directory TypeScript, loaded with jiti. No build step exists. This is the same pattern as pi-bg-tasks and the official subagent example.

```
┌──────────────────────────── parent pi process ────────────────────────────┐
│                                                                           │
│  pi-team extension (src/index.ts factory)                                 │
│  ┌───────────────┐   ┌──────────┐   ┌──────────┐   ┌───────────────┐     │
│  │ TeamRegistry  │◄──│ tools.ts │──►│ notify.ts │   │ statusline.ts │     │
│  └───────┬───────┘   └──────────┘   └──────────┘   └───────────────┘     │
│          │            team_spawn/status/result/steer/stop                │
│  ┌───────▼────────┐        ┌──────────────┐                             │
│  │ TeamMateProcess│───────►│ RpcClient     │  (pi --mode rpc)            │
│  │  per teammate  │ onEvent│ (child proc) │                             │
│  └────────────────┘        └──────────────┘                             │
│         ▲                                                            ▲    │
│         │ pi.sendMessage("team-notify") + registerMessageRenderer    │    │
│  ┌──────┴────────┐            ┌──────────────────────┐                 │    │
│  │ report-result  │◄─ -e ───── │  child pi process    │─────────────────┘    │
│  │ .ts companion  │            │  (headless teammate)│                     │
│  └────────────────┘            └────────────────────┘                     │
└───────────────────────────────────────────────────────────────────────────┘
```

Main architectural choice: each teammate is a live RPC child process. The parent holds one `RpcClient` connection per teammate. The design reuses the live-RPC architecture of the pi-children project. Detached print-mode runners are not used.

This choice gives three properties:

- Progress in real time. The parent reads the RPC event stream of each teammate. The events contain the current tool, recent activity, turn count, and token count. The extension does not read the disk for progress data.
- Immediate control. The steer operation interrupts the current turn. The followUp operation queues a message for after the current turn.
- Persistent teammates. The child process continues to run between tasks. The teammate keeps its conversation context. A new task on the same teammate starts immediately and uses this context.

Restriction accepted for v1: a teammate does not continue to run after a parent stop or parent failure. The child process and the RPC connection terminate with the parent. Restart recovery is a future phase (§12).

## 3. Teammate state machine

```
     team_spawn                  team_steer (idle: new task)
  ───────────▶ starting ──▶ running ◀─────────────┐
                              │     ▲             │
                              │     │ followUp queued while running
                              │     │ (stays running)
                              │     └─────────────┘
                              │
                              │ agent_settled + empty queue
                              ▼
                             idle ─┘
                              │
                              │ process exit or probe timeout
                              ▼
                            failed

  team_stop: any state → remove the entry
```

The states exist in `src/types.ts`:

- `starting`: The RpcClient starts and the extension sends the first prompt. The first `agent_start` event has not arrived. The status line counts this state as running.
- `running`: A task is active. A model turn is in progress, or the queue holds steer or follow-up inputs. The `queue_update` events give the pending count. An `agent_end` event with `willRetry: true` keeps the state running. A retry follows.
- `idle`: The child sent `agent_settled` and the event queue is empty. The task result is stored. The process continues to run. It stays in this state until `team_stop` or session shutdown. The stored deliverable remains readable with `team_result` until the next task replaces it.
- `failed`: The process terminated, or the health probe failed (see §6.3 for the probe rules). The registry keeps the entry. The parent can read the last activity and the partial result. `team_stop` removes the entry. This acknowledges the failure.

`team_stop` on any state stops the process, removes the entry, and refreshes the status line. Removal is the only exit from `failed`.

## 4. Deliverable contract

### 4.1 The report_result companion tool (child side)

`src/report-result.ts` is a small standalone extension. Each child loads it with `-e <absolute path>/src/report-result.ts`. It registers one tool:

```ts
parameters: Type.Object({
  status: Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("blocked")]),
  summary: Type.String({ description: "Concise outcome description for the coordinator" }),
  data: Type.Optional(Type.Any({ description: "Structured JSON payload (findings, metrics)" })),
  artifacts: Type.Optional(Type.Array(Type.String(), { description: "Paths of files produced" })),
}),
async execute(_id, params) {
  return { content: [{ type: "text", text: `Reported: ${params.status}` }], terminate: true };
}
```

The tool result sets `terminate: true`. This ends the teammate turn immediately after the report. The pattern is verified in `examples/extensions/structured-output.ts`. The tool result does not contain the deliverable. The parent reads the deliverable from the `tool_execution_start` event arguments. The event stream transmits the arguments without the size limits of a tool result. The tool uses `promptSnippet` and `promptGuidelines` so that the model can find it.

### 4.2 Capture (parent side)

The `onEvent` listener of the teammate processes the RPC event stream:

- `tool_execution_start` with `toolName === "report_result"`: the extension stores the arguments as the deliverable of this task. The record has {reported: true, status, summary, data, artifacts, capturedAt}.
- `agent_start`: the state changes to running.
- `tool_execution_*` and `message_end`: the extension appends each event to the ring buffer (10 items).
- `queue_update`: the extension tracks the count of pending steer and follow-up inputs. A queue that is not empty keeps the teammate in running state. A teammate has an empty queue before the first `queue_update` event arrives.
- `agent_end`: the turn ended. The event carries `willRetry`. With `willRetry: true`, a retry follows and the state stays running. The extension counts turns with this event.
- `agent_settled`: the child has no active run, no retry, and no queued continuation. The extension checks the last `queue_update` (both arrays empty) and the deliverable. If the extension captured a report_result, the state changes to idle and the completion sequence starts (§7). If no report_result was captured, the fallback deliverable is `client.getLastAssistantText()` with `reported: false`. The parent receives a notification in both cases.

The listener ignores events from a teammate in the failed state. Reason: a failed teammate has no valid transition. The extension stops the child when a probe sets the state to failed (§6.3).

### 4.3 Autonomy instruction

The extension appends this instruction to every teammate system prompt:

> You are an autonomous teammate. No human answers questions during this task. Make reasonable decisions. Note your assumptions and open questions in your report. Call `report_result` when your task is complete. Give the status: success, failure, or blocked. Write a summary for your coordinator. Add optional structured data and optional artifact paths. This ends your turn. Your coordinator may assign follow-up tasks later. Use your prior context for these tasks.

### 4.4 Command dispositions

The child returns a disposition for each prompt, steer, and followUp command. The extension checks every disposition:

- `prompt()` on an idle teammate: the extension requires the value "started".
- `steer()` and `followUp()`: the extension requires the value "queued".
- The value "handled" means that the child did not start and did not queue the input. The tool returns an explicit error. The state stays unchanged.

One exception exists: the first prompt. If the first prompt does not return "started", the extension stops the child, removes the registry entry, and returns an explicit error (the §8.1 error path). Reason: the teammate is in the starting state. A child in the starting state has no active turn and no path to a result.

## 5. Child invocation

Each teammate starts through the exported `RpcClient`:

```ts
new RpcClient({
  cliPath: <pi>/dist/cli.js,        // require.resolve("@earendil-works/pi-coding-agent") → dirname
  cwd: parentCwd,                   // all teammates work in the parent workspace
  env: { PI_TEAMMATE: "1" },        // recursion guard (RpcClient merges process.env itself)
  provider: <resolved>.provider,    // only when a model is resolved
  model: <resolved>.id,
  args: [
    "--no-session",               // ephemeral; the registry on the parent side persists the state
    "--no-extensions",             // clean child: no parent extensions (incl. pi-team) - explicit -e still works
    "--no-skills", "--no-prompt-templates", "--no-context-files",
    "-e", <abs path to src/report-result.ts>,
    ...childExtensions.flatMap(p => ["-e", p]),   // resolved (§5.2) + parent-provided (§8.1) extensions, deduped
    "--append-system-prompt", <tmp persona file>, // persona + §4.3 instruction; tmp file (long text)
    "--thinking", <level>,        // inherited with the model when applicable
    ...(tools ? ["--tools", tools.join(",") + ",report_result"] : []),
  ],
})
```

`RpcClient` prepends `--mode rpc` itself. Verified: the constructor spawns `node [cliPath, --mode rpc, ...]`.

### 5.1 Model resolution

The default is the parent model (`ctx.model`) plus the parent thinking level (`ctx.thinkingLevel`). This is a confirmed preference from an earlier project. Resolution order:

1. The `model` parameter of `team_spawn`, if present.
2. The active parent model and the parent thinking level.
3. If neither exists, the extension omits the model arguments. The child then uses its default from settings.

v1 has no model:thinking suffix. `team_spawn` takes separate `model` and `thinking` parameters. When level data is available, the extension validates the thinking level. Otherwise it passes the value through.

### 5.2 Provider restriction

Problem: the default parent provider (`ollama-cloud`) comes from an extension. The child runs with `--no-extensions`. Because of this, the child cannot resolve the inherited model.

Solution: the `childExtensions` config supplies extra `-e` paths. Default: the extension checks for `~/.pi/agent/npm/node_modules/pi-ollama-cloud/index.ts`. If the file exists, the extension adds it. The `piTeam.childExtensions` config overrides the list. The extension uses the installed path, not the npm: specifier. This avoids questions about downloads.

The `extensions` parameter of `team_spawn` (§8.1) adds per-spawn paths on top of this resolved list. The merge keeps the resolved order first and drops duplicates. File paths resolve against the spawn cwd and must exist, or the spawn fails before the child process starts. `builtin:<name>` values pass through without a disk check.

### 5.3 Headless guarantees

The child is not interactive by design:

- The child runs in RPC mode. This mode has no user interface.
- The child runs with `--no-extensions`. No ask-user style extension tools can load.
- The autonomy instruction tells the model that no human is available.

v1 does not bridge child UI requests to the parent (§12). With a clean child and a tool allowlist, this situation cannot occur. Future contributors who add interactive child extensions shall read this section.

## 6. Progress data

### 6.1 Activity buffer (parent side, one per teammate)

The extension keeps a ring buffer of the last 10 notable events for each teammate. The buffer stores `tool_execution_*` and `message_end` events only. Each entry has {ts, kind, name, preview}. The kind is "tool" or "message". The extension does not buffer `message_update` events. These events fire once per token. The extension reads the cumulative usage from each `message_update` event and derives the token counters: tokens in, tokens out. Other derived counters: turns, currentTool, lastEventAgeMs, queuedInputs. All progress data comes from the RPC event stream. The extension does not read the disk.

### 6.2 The team_status snapshot

`team_status` answers from the memory buffer without delay. The parent can call this tool at any time. With `detail: true`, the tool also calls `getState()` and `getSessionStats()` over RPC for deep inspection.

### 6.3 Health probe

The RpcClient class does not expose the child process handle. Because of this, the extension detects a terminated child with a health probe, not with events.

A timer runs every livenessIntervalMs (default 30 seconds). The timer runs only while the registry is not empty. Each probe calls `getState()`. The extension races the call with a 5-second limit (`Promise.race`). Reason: an RPC request waits up to 30 seconds before the client rejects it. The probe has two failure modes:

- The call rejects with a process exit error. The child process is dead. The extension sets the state to failed on the first probe.
- The race times out, or the call rejects for another reason. Two consecutive failures set the state to failed.

When a probe sets the state to failed, the extension calls `client.stop()` with a timeout. The extension ignores a stop error on this path. Reason: the child process can still be alive after a probe timeout. The event listener ignores events from a teammate in the failed state (§4.2).

The extension wraps every RPC call with a timeout, not only the probes. Reason: `client.stop()` clears the internal request map and does not reject pending calls. A call without a timeout can wait forever. The extension attaches an empty catch handler to the inner request of each race. Reason: the race leaves the inner request alive. A late rejection shall not produce an unhandled rejection.

A stuck teammate stays in running state. `team_status` shows lastEventAgeMs and currentTool. The parent uses this data to decide. It stops a stuck teammate with `team_stop`. The extension clears the timer when the registry becomes empty. It also clears the timer on session shutdown.

## 7. Task completion (notify and pull)

The extension sends exactly one notification per completed task. A flag on the task record prevents duplicates. The extension resets the flag when a new task starts.

1. The registry stores the deliverable. The teammate state changes to idle. The status line refreshes.
2. The extension appends a completion record to the session with `pi.appendEntry("pi-team-result", ...)`. The LLM does not see this entry. Other extensions and tools can read it.
3. The extension sends a notification into the parent conversation:

```ts
pi.sendMessage({
  customType: "team-notify",
  display: true,
  content: `🔔 team: "${name}" finished its task (${status}). Use team_result to pull the deliverable.`,
  details: { teammate: name, status, summaryPreview, deliveredAt },
}, {
  triggerTurn: !parentBusy,                  // start a parent turn when the parent is idle
  deliverAs: parentBusy ? "nextTurn" : "followUp",
});
```

   The factory tracks parent activity. It subscribes to the parent `agent_start` and `agent_settled` events. The parent is busy from `agent_start` to `agent_settled`. Reason: the parent `agent_end` event carries no retry data. A retry window sits between `agent_end` and the next `agent_start`. `agent_settled` fires only when the parent has no active run, no retry, and no queued continuation. If the parent is not busy, the notification starts a new parent turn. If the parent is busy, the message waits for the next turn.

4. `pi.registerMessageRenderer("team-notify", ...)` renders the notification in a compact display format.
5. `ctx.ui.notify` shows a short message in the terminal. This works in TUI mode only.

The parent then decides: it pulls the result with `team_result`, it gives a new task with `team_steer`, or it stops the teammate with `team_stop`. The extension never writes the full deliverable into the parent conversation automatically. This follows the notify-and-pull decision.

## 8. Tools

The extension registers all tools with `pi.registerTool`. All tools use `executionMode: "sequential"`. The tool descriptions tell the model when to use each tool. They also document the `team_steer` behavior table and the asynchronous workflow.

### 8.1 team_spawn: give a task

| Param | Type | Description |
|---|---|---|
| `task` | string (required) | The task text. It shall contain all context that the teammate needs. |
| `name` | string? | Unique name. Default: `teammate-<n>`. The tool rejects duplicates. |
| `systemPrompt` | string? | Persona text. The extension appends it to the child system prompt. |
| `tools` | string[]? | Tool allowlist. The extension appends `report_result`. Omit the list to permit all default tools. The child ignores a name that it does not know. Pass exact tool names. |
| `extensions` | string[]? | Extension paths the child loads with `-e`, in addition to the resolved child extensions (§5.2). Absolute or cwd-relative file paths, or `builtin:<name>`. File paths resolve against the spawn cwd. The spawn fails with a clear error when a file path does not exist; this happens before the child process starts. The merge drops duplicates. |
| `model` | string? | Model override. Default: the active parent model. |
| `thinking` | string? | Thinking level override. Default: the parent thinking level. |

The tool returns immediately. The result contains name, state, and model. It also contains this guidance text: "The extension sends a notification when this teammate reports. Use team_status to check the progress." The tool enforces maxTeammates (default 8). The tool writes the persona to a temporary file, builds the child arguments (§5), starts the RpcClient, and sends the first prompt. The tool checks the disposition of the first prompt (§4.4). The task continues in the background.

Three error cases exist:

- The child fails at startup. Example: an unknown `--model` value. `client.start()` throws after its internal 100-millisecond check. The tool catches the error, removes the registry entry, and returns a clear error text.
- The first prompt returns a disposition other than "started" (§4.4). The tool stops the child, removes the registry entry, and returns a clear error text.
- The extensions parameter names a file that does not exist. The tool returns a clear error text that lists the missing paths, before it starts any child process.
- The tools parameter can name a tool that the clean child does not have. The child ignores unknown names without an error. The tool description warns the model: pass exact tool names only.

### 8.2 team_status: check progress

Params: `teammate?: string`, `detail?: boolean`. No argument gives a snapshot of all teammates. The output uses `outputSchema` and `structuredContent` so that the model can parse the result reliably. Rows: {name, state, taskPreview (80 characters maximum), currentTool, lastEventAgeMs, turns, tokens, queuedInputs, ageMs, resultReady}. `detail: true` adds the full task text, the activity ring (10 events), the last assistant text preview, the live RPC state (`getState()`), and the context percentage (`getSessionStats()`). The memory buffer does not hold the context percentage. The tool fetches it live with `detail: true` only. Unknown name: the tool returns an explicit error.

### 8.3 team_result: pull a deliverable

Param: `teammate: string` (required, explicit). Cases:

- Idle or failed, with result: the tool returns {reported, status, summary, data, artifacts, deliveredAt, task}. The value `reported: false` marks the fallback text.
- Starting: the tool returns the text "The teammate is starting. No result exists yet."
- Running: the tool returns {state: "running", currentTool, lastEventAgeMs} and the text "still working".
- Failed, without result: the tool returns the last activity and the error reason.

The pull does not destroy data. Reads are repeatable. The next task replaces the stored result.

### 8.4 team_steer: steer, correct, or give a new task

Params: `teammate: string`, `message: string`, `mode?: "interrupt" | "queue"` (default: `"interrupt"`).

| Teammate state | Behavior |
|---|---|
| `idle` | `prompt()` sends a new task. The extension resets the delivered flag. The state changes to running. |
| `running` + interrupt | `steer()` interrupts the current turn. The teammate processes the message immediately. |
| `running` + queue | `followUp()` queues the message. The teammate processes it after the current turn. |
| `starting` | The tool returns an explicit error: "The teammate is starting. Call team_status, then retry." |
| `failed` | The tool returns an explicit error: "The teammate failed. Use team_stop." |

One tool covers both cases: steer prompts during a task, and new tasks for an idle teammate. The result text states which path was taken. The tool checks the disposition of each command (§4.4).

### 8.5 team_stop: stop a teammate

Params: `teammate?: string`, `all?: boolean`. One of the two is required. Each stop call is `client.stop()`. The client sends SIGTERM, then SIGKILL after an internal 1-second wait. The extension does not send signals itself. The process handle is private. With `all: true`, the tool stops all teammates in parallel (`Promise.all`). Reason: one stop call can take up to 1 second, and sequential stops are too slow for 8 teammates. The operation is idempotent. The tool removes the registry entries. This also clears failed entries. The status line refreshes. If the teammate was running, the result text notes that no deliverable will exist.

## 9. Status line

- API: `ctx.ui.setStatus("pi-team", text)`. The extension calls `setStatus("pi-team", undefined)` when the registry is empty. The line then disappears. The line appears only while teammates exist.
- Refresh: event-driven. The extension refreshes the line on each state change: spawn, task completion, failure, stop. The health probe is the only timer.
- Format: the running count includes starting. The line omits segments with a zero count. The failed segment appears only when the count is larger than zero. The extension joins the segments with " · ".

```
🤖 2 running · 1 idle
🤖 3 running
🤖 1 idle · 2 failed
🤖 1 failed
```

The line starts with the 🤖 emoji. This identifies the line. The convention matches pi-bg-tasks (🧵 prefix).

The extension guards `ctx.mode === "tui"` around setStatus and notify calls. All tools work in every mode.

## 10. Registry and persistence

`TeamRegistry` (`src/registry.ts`) holds an in-memory map of name to TeamMateProcess. Persistence:

- Each state change appends an entry: `pi.appendEntry("pi-team-registry", {teammates: [...snapshot]})`. Custom entries do not go to the LLM. The extension limits the number of writes per turn. Exception: the session_shutdown path appends nothing (see the session_shutdown rules below).
- `session_start`: the extension restores the registry from the session file. Live processes do not survive a restart. This is a documented v1 restriction (§12). Restore rules:
  - Read the latest `pi-team-registry` entry with `ctx.sessionManager.getEntries()`.
  - If the latest entry is empty or no entry exists, restore nothing. An empty entry means that the user stopped the last teammate before the session ended. `team_stop` appends normally (§8.5). The extension shall respect this removal.
  - Otherwise restore the entries as frozen stubs. Keep the last state, the task, and the deliverables. `team_result` can still read delivered data. Each restored running or starting entry becomes failed. After the restore, append one snapshot with the processed states.
  - The failure note names the reason from the `session_start` event. The notes are: "parent session restarted" (startup), "parent session reloaded" (reload), "parent session resumed" (resume), "forked session" (fork). A new session has no entries. A fork copies all entries from the source session.
  - A frozen stub has no live client. `team_result` reads the stored deliverable. `team_stop` removes the stub. `team_steer` returns an explicit error for a stub.
- `session_shutdown`: the extension stops all teammates in parallel (`Promise.all`). Each stop call is `client.stop()` (SIGTERM, then SIGKILL after an internal 1-second wait). This is a confirmed decision from an earlier project. The shutdown path does not append a registry entry. Reason: the stopAll removals are state changes, but a shutdown entry would be empty. A later restore (reload, resume) shall read the last snapshot with the live teammates, not an empty entry. `team_stop` appends normally during a session. The extension clears the health probe and all timers. It clears the status line. The operation is idempotent. The factory itself creates no resource. All process creation happens inside tool execute functions. This obeys the Pi lifecycle rule.
- `counts()`: {running (starting + running), idle, failed}. The registry is the only data source for the status line counts.

## 11. Recursion prevention

Two layers prevent recursion:

1. Children run with `--no-extensions`. The child cannot load pi-team.
2. The child environment sets PI_TEAMMATE=1. The first line of the factory checks this variable. If the value is 1, the factory returns an empty extension. This protects the child even if a user adds pi-team through childExtensions.

v1 does not permit teammates that start teammates.

## 12. Not in v1 (future phases)

- Parent restart recovery. Detached runner, on-disk status, reattach. v1: teammates terminate with the parent.
- Questions from child to parent during a task. Transport of child UI requests to the parent over RPC. v1 teammates are autonomous by instruction.
- Recursive teammates with a depth limit.
- Profile files for reusable teammate roles. The user chose inline personas.
- A `/team` dashboard command for the human user.
- Model fallover chains and per-provider token budgets.
- Automatic delivery of the full deliverable into the parent conversation. The notify-and-pull mode replaces it.

## 13. Assumptions from earlier projects

Approve or reject these assumptions now. Otherwise they stay in the design.

1. The child model defaults to the active parent model and the parent thinking level.
2. Session shutdown stops all teammates.
3. All teammates use the parent working directory (shared workspace).
4. `team_result` reads do not delete data.
5. Spawns are asynchronous only. No tool waits for the completion of a task. The specification requires that the parent can check progress at any time.

## 14. Modules and test plan

```
pi-team/
  package.json          # name pi-team, private, type: module
  tsconfig.json
  DESIGN.md
  src/
    index.ts            # factory: guard, config load, tool registrations,
                        #   parent busy state, session_start restore, session_shutdown
    types.ts            # TeamMateState, Deliverable, ActivityEvent, PiTeamConfig, RegistrySnapshot
    config.ts           # settings.json "piTeam" block, global + project merge (auto-title pattern)
    child-args.ts       # build RpcClientOptions: flags, persona tmp file, model and thinking resolution,
                        #   childExtensions detection, autonomy instruction composition
    process.ts          # TeamMateProcess: RpcClient wrapper, event buffer, state machine,
                        #   deliverable capture, steer/prompt/stop operations (client injected for tests)
    registry.ts         # TeamRegistry: map, counts, appendEntry persistence, restore, stopAll
    notify.ts           # completion sequence: dedupe, sendMessage, renderer registration, ui.notify
    statusline.ts       # formatStatusLine(counts) pure function + setStatus glue
    tools.ts            # team_spawn / team_status / team_result / team_steer / team_stop
    report-result.ts    # companion extension loaded into children (§4.1)
  test/                 # vitest
```

Test plan (TDD, vitest, same stack as pi-bg-tasks):

- Unit tests, pure functions: formatStatusLine matrix (all count combinations, zero-segment rules, failed-only-when-nonzero), registry counts, state transitions (idle to running on a new task, failed on termination), deliverable capture from synthetic event streams, name generation, duplicate name rejection, duplicate notification prevention.
- Unit tests with a fake client: TeamMateProcess uses a scripted fake client (interface injection). Tests: report, then idle, then notification. No-report fallback. Steer decision table (idle: prompt; running: steer; running: followUp; starting: error; failed: error). Disposition checks (prompt returns "started"; steer and followUp return "queued"; "handled" returns an error). An `agent_end` event with `willRetry: true` keeps the state running. A `queue_update` with empty arrays arrives after the last queued followUp is consumed, and the state changes to idle. Two consecutive probe failures (or a probe process exit error) call `client.stop()`, and the listener ignores later events from the failed teammate. A first prompt with the disposition "handled" stops the child and removes the registry entry.
- Factory smoke tests: import and factory start create no process. PI_TEAMMATE=1 disables the extension. The factory creates no timer. session_shutdown is idempotent and stops all fake teammates.
- End-to-end test, manual, in a live pi session: start a slow task; the status line shows "🤖 1 running". Call team_status during the task; it shows the current tool. Steer during the task. The notification arrives while the parent is idle. Pull the deliverable with team_result. Give a new task to the idle teammate; the teammate keeps its context. Stop all teammates; the status line disappears. Stop the parent; no orphan processes remain. Start several teammates at the same time and verify the notifications: the extension uses triggerTurn with deliverAs "followUp" while the parent is idle. Steer a running teammate, then let its turn end without report_result. The fallback notification fires. This is the intended behavior.

## 15. Verified APIs (pi 1.0.0)

All items below were checked against the installed distribution.

- `RpcClient` is exported from `@earendil-works/pi-coding-agent`. `RpcClientOptions`: {cliPath?, cwd?, env?, provider?, model?, args?}. The constructor spawns `node [cliPath, --mode rpc, ...]`. Methods used: start, stop, onEvent, prompt, steer, followUp, getState, getSessionStats, getLastAssistantText, waitForIdle, setModel, setThinkingLevel. Internals (verified): `start()` throws after a 100-millisecond check when the child exits early; `stop()` sends SIGTERM, then SIGKILL after an internal 1-second wait, and clears the request map without rejection of pending calls; `send()` rejects after a fixed 30-second request timeout, and rejects immediately after a child process exit.
- Child event stream (verified): `agent_end` carries {messages, willRetry}; `agent_settled` fires only after the post-run loop drains the queue and the retries (source: `_runAgentPrompt`); `queue_update` carries {steering, followUp} string arrays and fires when the child consumes a followUp message (source: `_emitQueueUpdate`); `message_update` carries cumulative usage. `waitForIdle()` resolves on `agent_settled`.
- Session lifecycle (verified): a reload sends session_shutdown with reason "reload" to the old extension runner before the new factory runs. SessionShutdownEvent reasons: quit, reload, new, resume, fork (source: `dist/core/extensions/types.d.ts:610`). `Session.forkFrom` copies every non-header entry to the forked session file (source: `dist/core/session-manager.js`), so a fork restores frozen stubs.
- `--tools` is a true allowlist. The child activates a named tool even when the tool is inactive by default. The child removes default tools that are not named. The child ignores a name that it does not know. Source: `dist/core/agent-session.js`.
- CLI: `--no-session`; `--no-extensions` ("explicit -e paths still work"); `--no-skills`; `--no-prompt-templates`; `--no-context-files`; `--tools`; `--append-system-prompt` (text or file, repeatable); `--thinking`.
- `AgentToolResult.terminate: true` ends the turn. Pattern: `examples/extensions/structured-output.ts`. ToolDefinition supports promptSnippet, promptGuidelines, executionMode ("sequential" | "parallel"), outputSchema and structuredContent.
- `pi.sendMessage` takes {customType, content, display, details} and options {triggerTurn, deliverAs: "steer" | "followUp" | "nextTurn"}. `pi.registerMessageRenderer(customType, renderer)`. `pi.appendEntry(customType, data)`. Custom entries do not go to the LLM. `pi.getThinkingLevel()`. Extension events: session_start (with reason and previousSessionFile), session_shutdown, agent_start, agent_end, agent_settled (verified `on()` overloads). The parent `agent_end` event carries no retry flag. `agent_settled` is the idle signal.
- Extension context (verified): `ctx.model`, `ctx.thinkingLevel`, `ctx.sessionManager` (ReadonlySessionManager, with `getEntries()`), `ctx.mode`, `ctx.ui.setStatus(key, text | undefined)`, `ctx.ui.notify(message, type)`.
- The official example `examples/extensions/subagent` is present. `Type` comes from `"typebox"`.

## 16. Completion criteria

1. All tests pass. `tsc --noEmit` reports no errors.
2. The manual end-to-end checklist (§14) passes in a live pi session with a live model.
3. The status line appears on the first spawn, updates on each state change, and disappears when the last teammate stops.
4. A parent restart leaves no orphan processes.
