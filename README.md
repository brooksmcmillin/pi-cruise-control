# pi-cruise-control

Automatic tool-use classification for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Every tool call is rated by an LLM on two axes before it runs, and denied calls come back to the
agent with a one-sentence reason so it can narrow the request or escalate to a human instead of
guessing.

| Axis | Question | Values |
|------|----------|--------|
| `risk` | What happens if this runs? | `low` / `medium` / `high` |
| `intent` | How clearly did the user ask for it? | `low` / `medium` / `high` |

**A call is approved when risk is `low`, or intent is `high`, or both are `medium`.**

Note what the second clause means in practice: **intent is an override**. An action the user
explicitly asked for is approved even when the classifier rates it high risk — the rule reads an
explicit request as the human authorization. If you want deny rules to be absolute regardless of
what the user typed, this is not the policy you want.

## Install

```bash
pi install pi-cruise-control
```

Or load it directly during development:

```bash
pi -e ./index.ts
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

### Keys

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | `false` leaves every tool call untouched |
| `model` | session model | `provider/model-id` for the classifier |
| `reasoning` | `"low"` | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `timeout_ms` | `20000` | Budget for one classification |
| `on_error` | `"deny"` | Outcome when classification fails: `allow` or `deny` |
| `skip_tools` | `[]` | Tool names that bypass classification |
| `cache.enabled` | `true` | Cache low-risk verdicts |
| `cache.ttl_ms` | `1800000` | Cached verdict lifetime (30 min) |
| `cache.max_entries` | `500` | LRU bound |
| `log.enabled` | `true` | Write the audit trail |
| `log.dir` | `<agent-dir>/cruise-control` | Audit log directory |
| `log.retention_days` | `30` | Daily log files older than this are pruned at session start; `0` disables pruning |
| `instructions.*` | built-in defaults | Four rule lists injected into the classifier prompt |

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

## Caching

Only **low-risk** verdicts are cached, keyed by tool name, canonicalized arguments, and a
fingerprint of the model plus instructions. Repeating a `read` or `ls` is the common case and a
cache hit there saves a model round trip; anything rated medium or high is re-judged every time,
because the intent half of the verdict depends on prompts that keep moving. Editing the
instructions or the model retires every cached approval rather than letting it outlive the rules
that produced it.

## Audit log

Every decision is appended as one JSON line to `<log.dir>/cruise-control-YYYY-MM-DD.jsonl`:

```json
{"timestamp":"2026-08-02T07:38:18.315Z","toolName":"bash","toolCallId":"call_01","cwd":"/project",
 "input":"{\"command\":\"ls\"}","approved":true,"risk":"low","intent":"high",
 "reason":"User explicitly asked to list files with ls; read-only and safe.",
 "source":"model","durationMs":1443,"model":"deepseek-v4-flash"}
```

`source` is `model`, `cache`, `skipped`, or `fallback` (classification never produced a verdict and
`on_error` decided). Writes are queued so concurrent tool calls cannot interleave partial lines, and
every log failure is swallowed — an unwritable log directory must never be able to fail a tool call.

## Failure behavior

When the classifier cannot produce a verdict — no model available, request error, timeout, or
unparseable output — the outcome comes from `on_error`, which defaults to `deny`. Denials name the
cause so the agent can react:

```
cruise-control denied this tool call (risk=high, intent=low): Classification unavailable
(classification aborted); denied by fallback policy.
Retry with a safer, narrower tool call, or use the ask tool to request human review.
```

Set `on_error` to `"allow"` if you would rather a classifier outage not block your session.

## License

MIT
