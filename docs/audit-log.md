# Audit log

Every decision — approved, denied, cached, skipped, or fallback — is appended as one JSON line to
`<log.dir>/cruise-control-YYYY-MM-DD.jsonl`, one file per UTC day.

```json
{"timestamp":"2026-08-02T07:38:18.315Z","toolName":"bash","toolCallId":"call_01","cwd":"/project",
 "input":"{\"command\":\"ls\"}","approved":true,"risk":"low","intent":"high",
 "reason":"User explicitly asked to list files with ls; read-only and safe.",
 "source":"model","durationMs":1443,"attempts":1,"queueMs":0,"model":"deepseek-v4-flash"}
```

## Fields

| Field | Meaning |
|-------|---------|
| `timestamp` | ISO 8601, UTC |
| `toolName`, `toolCallId`, `cwd` | What was being attempted, and where |
| `input` | Serialized tool arguments, truncated past 2000 characters |
| `approved` | The outcome the host acted on |
| `risk`, `intent`, `reason` | The verdict |
| `source` | `model`, `cache`, `skipped`, or `fallback` |
| `durationMs` | Gate entry to verdict, including queue wait and retries |
| `attempts` | Classification attempts; `0` for cache hits and skips |
| `queueMs` | Time spent waiting for a concurrency slot |
| `model` | The classifier model that produced the verdict |

A `source` of `fallback` means classification never produced a verdict and `on_error` decided the
outcome; the `reason` field names the underlying cause and, when more than one was made, the number
of attempts.

## Durability and retention

Writes are chained onto a single promise, so concurrent tool calls cannot interleave partial lines,
and the queue is drained at session shutdown so no record is lost on exit. Every logging failure is
swallowed deliberately: an unwritable log directory must never be able to stall or fail a tool call.
That trade-off is worth knowing if you rely on the log for compliance — it is best-effort, not a
write-ahead log.

Files older than `log.retention_days` are deleted at session start. Pruning is done there rather
than on a timer so the extension never holds a background resource. Set `log.retention_days` to `0`
to keep everything, or `log.enabled` to `false` to write nothing at all.
