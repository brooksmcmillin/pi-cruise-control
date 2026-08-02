# Configuration keys

Every key below lives under the `cruise_control` object in `~/.pi/agent/settings.json` (global) or
`<project>/.pi/settings.json` (project). The global file is read first and the project file wins on
conflicts.

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | `false` leaves every tool call untouched |
| `model` | session model | `provider/model-id` for the classifier |
| `reasoning` | `"high"` | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `timeout_ms` | `20000` | Budget for a **single attempt**; each retry gets a fresh budget |
| `on_error` | `"deny"` | Outcome when classification fails: `allow` or `deny` |
| `skip_tools` | `[]` | Tool names that bypass classification |
| `retry.attempts` | `2` | Extra attempts after the first; `0` disables retrying |
| `retry.initial_delay_ms` | `500` | Base backoff, doubled per attempt |
| `retry.max_delay_ms` | `4000` | Backoff ceiling |
| `parallel` | `true` | `false` classifies one tool call at a time |
| `max_concurrent` | `0` | Classifications in flight at once; `0` is unlimited |
| `cache.enabled` | `true` | Cache low-risk verdicts |
| `cache.ttl_ms` | `1800000` | Cached verdict lifetime (30 min) |
| `cache.max_entries` | `500` | LRU bound |
| `log.enabled` | `true` | Write the audit trail |
| `log.dir` | `<agent-dir>/cruise-control` | Audit log directory |
| `log.retention_days` | `30` | Daily log files older than this are pruned at session start; `0` disables pruning |
| `instructions.*` | built-in defaults | Four rule lists injected into the classifier prompt |

## A fuller example

```json
{
  "cruise_control": {
    "model": "ollama-cloud/deepseek-v4-flash",
    "reasoning": "high",
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

## Defaults are written down once setup is complete

The instruction lists start as built-in defaults that exist only in memory, which makes the most
important part of the extension — the rules — invisible and hard to tune. So the first time
classification is genuinely set up (`enabled` is true **and** a `model` is configured), the built-in
lists are written into the global settings file verbatim, and a notice points at the path.

After that they are ordinary configuration: edit them, delete entries, add your own. The write is
guarded on whether *any* settings file supplied at least one list, so hand-written rules are never
overwritten — including a project file that sets only `allow`. If the settings file cannot be
written, the same defaults stay in force in memory and nothing fails.

This happens at session start, and also right after `/cruise-control on` or `/cruise-control model`
completes the setup, so the rules appear at the moment classification becomes usable rather than on
the next session.

## Merge semantics

Scalar keys are overridden individually, so a project file that sets only `reasoning` inherits the
rest of the global configuration. Nested objects (`retry`, `cache`, `log`) merge key by key for the
same reason.

Each `instructions` list, however, is **replaced rather than merged**: setting `deny` in a project
file means "these are the deny rules", not "these as well". Rule lists are read as a complete policy
statement, and silently appending to an inherited deny list would make a project's policy depend on
a global file its author may never have seen.

## Instruction lists

The four lists become the four labelled sections of the classifier's system prompt.

| List | Role |
|------|------|
| `background` | Context about the workspace and what normal work looks like |
| `allow` | Operations that should normally be rated low risk |
| `conditional` | Cases to judge individually, including mixed safe/destructive commands |
| `deny` | Operations to treat as high risk |

Empty lists are omitted from the prompt entirely rather than emitted as an empty heading.
