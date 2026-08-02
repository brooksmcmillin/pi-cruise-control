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
pi install git:github.com/puetsua/pi-cruise-control@0.1.0   # pinned to a tag
```

## Configure

Inactive until a `cruise_control` key exists in `~/.pi/agent/settings.json` (global) or
`<project>/.pi/settings.json` (project), so installing it never silently changes how your tools run.

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

## License

MIT
