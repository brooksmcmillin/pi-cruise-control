# pi-cruise-control

Automatic tool-use classification for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Every tool call is rated by an LLM on two axes before it runs, and denied calls come back to the
agent with a one-sentence reason so it can narrow the request or escalate to a human instead of
guessing.

| Axis | Question | Values |
|------|----------|--------|
| `risk` | What happens if this runs? | `low` / `medium` / `high` |
| `intent` | How clearly did the user ask for it? | `low` / `medium` / `high` |

A call is approved when risk is `low`, or intent is `high`, or both are `medium`:

| risk ↓ / intent → | `low` | `medium` | `high` |
|---|---|---|---|
| **`low`** | approve | approve | approve |
| **`medium`** | deny | approve | approve |
| **`high`** | deny | deny | approve |

Note the right-hand column: **intent is an override**. An action the user explicitly asked for is
approved even when the classifier rates it high risk — the rule reads an explicit request as the
human authorization. If you want deny rules to be absolute regardless of what the user typed, this
is not the policy you want.

## Install

```bash
pi install git:github.com/puetsua/pi-cruise-control
pi install git:github.com/puetsua/pi-cruise-control@0.1.0   # pinned to a tag
```

## Configure

The extension is **inactive until a `cruise_control` key exists** in a settings file, so installing
it never silently changes how your tools run. Configuration is read from the global file first and
then the project file, with the project winning:

- `~/.pi/agent/settings.json` (global)
- `<project>/.pi/settings.json` (project)

```json
{
  "cruise_control": {
    "model": "ollama-cloud/deepseek-v4-flash",
    "reasoning": "low",
    "instructions": {
      "background": [
        "The user is doing software engineering work in a local project workspace.",
        "Read, search, and list operations inside the project workspace are normal exploratory work.",
        "When impact is unclear or irreversible, prefer deny so the host can escalate for human review."
      ],
      "allow": [
        "Allow read, grep, find, and ls tools for files inside the project workspace.",
        "Allow harmless shell commands that only inspect state or print output without modifying the system.",
        "Allow routine edits and writes that are clearly scoped to the current project task."
      ],
      "conditional": [
        "Allow git commands that inspect or commit locally, but treat push and history rewrite as higher risk.",
        "Allow package installs only when they target the current project and do not elevate privileges.",
        "Deny when a command mixes a mostly safe operation with a clearly destructive flag or target."
      ],
      "deny": [
        "Deny recursive force deletes such as rm -rf or equivalent recursive wipe commands.",
        "Deny DROP DATABASE, DROP SCHEMA CASCADE, and TRUNCATE TABLE against real data stores.",
        "Deny force-push to main or master.",
        "Deny filesystem format commands such as mkfs and dd writes to device paths."
      ]
    }
  }
}
```

Each `instructions` list is **replaced**, not merged, when a project overrides it: setting
`deny` in a project file means "these are the deny rules", not "these as well".

## Commands

```
/cruise-control                        show effective configuration
/cruise-control stats                  session counters and averages
/cruise-control model <provider/id>    set the classifier model (global settings)
/cruise-control reasoning <level>      set the reasoning level (global settings)
```

`stats` reports approvals and rejections, where each decision came from, and the average risk and
intent for the session:

```
cruise-control - session stats
  classified 14 (approved 12, rejected 2)
  sources    cache 5, fallback 0, skipped 0
  avg risk   1.36 (low)
  avg intent 2.43 (medium)
  risk       low 10, medium 3, high 1
  intent     low 1, medium 6, high 7
  latency    avg 812ms over 11.4s total
  by tool    bash 6/7, read 5/5, edit 1/2
```

Counters reset at every session start. Averages cover model and cache decisions only — a
`fallback` carries no model judgement, so it is counted but never folded into the averages.

## License

MIT
