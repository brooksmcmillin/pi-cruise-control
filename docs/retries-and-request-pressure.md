# Retries and request pressure

## Retries

A stalled or erroring endpoint is retried with exponential backoff and full jitter — `500ms`, `1s`,
`2s`, capped at `max_delay_ms`, each delay randomized across its range so sibling tool calls do not
resynchronize into a burst against an endpoint that is already struggling.

**`timeout_ms` is per attempt, not per classification.** Each attempt gets a fresh budget, so a
single slow request cannot spend the whole allowance. With the defaults (`timeout_ms: 20000`,
`retry.attempts: 2`) a classification is willing to spend up to three attempts before falling back.

What is retried:

| Failure | Retried | Why |
|---------|---------|-----|
| Request/network error | yes | Usually transient |
| Attempt timeout | yes | The next attempt gets a fresh budget |
| Provider returned an error stop reason | yes | Rate limits and overload recover |
| Reply that is not a usable verdict | yes | Sampling variance; another draw often parses |
| No model available | no | Configuration fault, unchanged by retrying |
| Missing or unresolvable credentials | no | Configuration fault, unchanged by retrying |
| Turn cancelled | no | Pressing Esc must not be answered with a backoff loop |

Non-retryable faults short-circuit to the fallback immediately rather than sleeping through a
backoff schedule that cannot change the outcome. Set `retry.attempts` to `0` to disable retrying.

## Concurrency

`max_concurrent` caps how many classifications may be in flight at once; `0` means unlimited.
`"parallel": false` is the plain-language spelling of a cap of one. When both keys appear in the
same settings file, `max_concurrent` wins, since it is the more precise statement.

Cache hits never enter the queue, so a repeat `read` is never held up behind an in-flight request.

Worth knowing before you tune this: **pi already preflights sibling tool calls sequentially** —
`beforeToolCall` is awaited inside a `for` loop over the tool calls of an assistant message — so
classifications do not overlap under the stock host and the cap rarely engages. It exists so the
ceiling is a property of this extension rather than an inherited scheduling detail, and so retries,
which multiply request volume, cannot stack up behind a slow endpoint.

## Observing it

Both dimensions are recorded per decision and surfaced by `/cruise-control stats`:

```
  retries    4 across 2 decisions
  queued     1.2s waiting for a slot
```

Those two lines appear only when the counters are non-zero. The audit log carries the same numbers
per record as `attempts` and `queueMs`, so a slow session can be attributed to endpoint latency,
retry loops, or queueing after the fact.
