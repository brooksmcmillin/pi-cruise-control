# pi-cruise-control

Automatic tool-use classification for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Every tool call is rated by an LLM before it runs, and denied calls come back to the agent with a
one-sentence reason.

| Axis | Question | Values |
|------|----------|--------|
| `risk` | What happens if this runs? | `low` / `medium` / `high` |
| `intent` | How clearly did the user ask for it? | `low` / `medium` / `high` |

| risk ↓ / intent → | `low` | `medium` | `high` |
|---|---|---|---|
| **`low`** | approve | approve | approve |
| **`medium`** | deny | approve | approve |
| **`high`** | deny | deny | approve |

Intent overrides risk: an action the user explicitly asked for is approved even when the classifier
rates it high risk.

## Install

```bash
pi install git:github.com/puetsua/pi-cruise-control
pi install git:github.com/puetsua/pi-cruise-control@0.2.0   # pinned to a tag
```

## Configure

Inactive until a `cruise_control` key exists in `~/.pi/agent/settings.json` (global) or
`<project>/.pi/settings.json` (project), so installing it never silently changes how your tools run.
`/cruise-control on` writes one for you; once a model is set, the default rules are written into the
settings file too, ready to edit.

```json
{
  "cruise_control": {
    "model": "ollama-cloud/deepseek-v4-flash",
    "reasoning": "high",
    "instructions": {
      "background": ["The user is doing software engineering work in a local project workspace."],
      "allow": ["Allow read, grep, find, and ls tools for files inside the project workspace."],
      "conditional": ["Allow git commands that inspect or commit locally, but treat push as higher risk."],
      "deny": ["Deny recursive force deletes such as rm -rf."]
    }
  }
}
```

## Commands

```
/cruise-control                        show effective configuration
/cruise-control on | off               enable or disable classification
/cruise-control stats                  session counters and averages
/cruise-control model [provider/id]    pick from available models, or set one directly
/cruise-control reasoning [level]      pick a reasoning level, or set one directly
```

`model` and `reasoning` open a searchable picker when called without an argument.

## Health check tool

The extension also registers a read-only tool the agent can call to test the classifier:

```
cruise_control_health
```

It reports configuration state (active/inactive/disabled), which model is in use and whether it
resolves, cache and session stats, and then runs a **live probe**: one real classification of a
benign `read` call through the configured model, with latency. A healthy classifier approves that
call; a fault shows up as the exact error and whether it is retryable. The tool is exempt from the
gate itself, so a classifier that is down or misconfigured still gets diagnosed instead of blocking
its own health check with a fallback denial.

## License

MIT
