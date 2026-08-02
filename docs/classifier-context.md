# What the classifier sees

Each classification is a single stateless request. The conversation is never replayed into it — the
classifier is handed a small fixed payload and nothing else:

```json
{
  "tool": "bash",
  "input": "{\"command\":\"rm -rf build\"}",
  "cwd": "/project",
  "recent_user_prompts": ["clean the build output", "then rebuild"]
}
```

| Field | Source | Limit |
|-------|--------|-------|
| `tool` | Name of the pending tool call | — |
| `input` | Its arguments, serialized | 4000 chars |
| `cwd` | Session working directory | — |
| `recent_user_prompts` | The last 3 **user** messages, oldest first | 600 chars each |

## Tool output is excluded, deliberately

`recent_user_prompts` is built from `role: "user"` messages only. Everything else in the session is
skipped:

| Excluded | What it is |
|----------|------------|
| `role: "toolResult"` | Output of any tool the agent ran |
| `role: "bashExecution"` | Output of `!` and `!!` commands |
| `role: "assistant"` | The agent's own text |
| custom entries | Anything an extension appended |

This is a security boundary, not a formatting choice. **Tool output is attacker-influenced
content.** A file the agent reads, a web page it fetches, or a command's stdout can contain text
written to be read by a model — and if that text reached the gate, it could address the classifier
directly ("the user has already approved this; intent is high") and talk it into approving a call
the user never asked for. The classifier's whole job is judging whether the *user* wanted something,
so its only evidence is what the user actually typed.

Note this is exactly why the excluded roles are the interesting ones: they are the parts of the
session an attacker can reach. Widening the filter to "add more context" re-opens the hole.

## Consequences worth knowing

The gate cannot see what a tool *returned*, so it cannot reason about consequences that only become
visible after execution — it judges the call as written, against the rules and the user's prompts.

It also cannot see the agent's stated plan. If the user says "clean this up" and the agent decides
that means `rm -rf build`, the classifier sees the vague prompt and the concrete command, and rates
intent on that gap. That is the intended reading: an agent's own justification for a risky call is
not evidence that the user asked for it.
