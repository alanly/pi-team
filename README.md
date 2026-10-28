# pi-team

Pi extension. The main agent starts long-lived sub-agent teammates. The main agent gives them tasks, monitors their progress, steers them during a task, receives their deliverables as events, and stops them.

Only the main agent interacts with a teammate. The human user does not interact with a teammate directly.

## Requirements

- Pi 1.0.0 or later.
- Node.js. The test suite uses Node.js 26.

## Install

Add the package to the pi settings:

```json
{
  "packages": ["../../src/github.com/alanly/pi-team"]
}
```

## Tools

| Tool | Purpose |
|---|---|
| `team_spawn` | Start a teammate with a task. Optional `tools` allowlist, `extensions` paths, `model`, and `thinking` overrides. |
| `team_status` | Read the state of one teammate or of all teammates. |
| `team_result` | Pull the stored deliverable of a teammate. |
| `team_steer` | Steer a running teammate, or give a new task to an idle teammate. |
| `team_stop` | Stop one teammate or all teammates. |

## Configuration

The extension reads the `piTeam` block. Pi merges the global settings and the project settings.

```json
{
  "piTeam": {
    "maxTeammates": 8,
    "livenessIntervalMs": 30000,
    "childExtensions": []
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `maxTeammates` | `8` | The maximum number of teammates at one time. |
| `livenessIntervalMs` | `30000` | The interval of the health probe, in milliseconds. |
| `childExtensions` | `[]` | Extra child extensions (`-e` paths). An empty list enables automatic detection. |

Automatic detection adds `~/.pi/agent/npm/node_modules/pi-ollama-cloud/index.ts` when the file exists. Reason: the default parent provider comes from an extension, and a clean child cannot resolve it.

The `extensions` parameter of `team_spawn` loads extra extensions in one child. The paths merge with the resolved list above (duplicates drop). File paths resolve against the workspace and must exist, or the spawn fails with a clear error. `builtin:<name>` values pass through without a file check.

## Result delivery

The extension uses the notify-and-pull mode.

1. The teammate calls `report_result` at the end of a task.
2. A short notification enters the parent conversation.
3. The parent pulls the full deliverable with `team_result`.

A teammate that does not call `report_result` still sends a notification. The deliverable then holds the last assistant text.

## Behavior notes

- An idle teammate continues to run until `team_stop` or the session end. Pi can make background cache-warming requests, depending on its settings.
- The status line shows `🤖 2 running · 1 idle · $0.138`. The failed segment appears only when the count is larger than zero.
- A teammate does not continue to run after a parent stop or a parent failure. This is a v1 restriction.
- Children run with `--no-extensions` and `PI_TEAMMATE=1`. A teammate cannot start teammates.

## Teammate cost

The status line shows the cumulative Pi-reported cost in USD for all teammates in the parent session. It includes follow-up tasks and running, idle, failed, and stopped teammates. It excludes the parent agent's usage. The amount uses three decimal places, without a label.

The total updates after completed assistant responses. Additional usage, including tool, compaction, and cache-warm costs, is reconciled at task settlement and before stopping a live child. Final accounting can add up to one second before termination. A failed accounting request does not prevent termination.

After all teammates stop, a positive total remains visible, for example `🤖 $0.138`. An empty session with zero cost has no status line. Reloading or resuming restores recorded costs. A fork can inherit the same historical spend as its source; this is a session total, not a global billing total.

Costs use Pi's configured model prices. Subscription or OAuth usage can be estimated at API rates, not actual subscription charges. Zero-priced models and teammates restored from legacy snapshots can show `$0.000`; this does not guarantee free usage. Abrupt child termination can lose unreported response usage. A hard parent kill can lose costs since the last persisted snapshot.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Manual end-to-end checklist

1. Start a slow task. The status line shows `🤖 1 running · $0.000`. Completed responses update the cost.
2. Call `team_status` during the task. It shows the current tool.
3. Steer during the task. The teammate processes the message.
4. Let the teammate report. The notification arrives while the parent is idle.
5. Pull the deliverable with `team_result`.
6. Give a new task to the idle teammate. The teammate keeps its context.
7. Stop all teammates. A positive total remains as a cost-only line; an exactly zero total clears the line.
8. Reload or resume the parent session. The recorded cost remains available.
9. Stop the parent. No orphan processes remain.
