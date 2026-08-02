# Failure behavior

## When classification cannot produce a verdict

No model available, request error, timeout, or unparseable output: retries are exhausted first, and
then the outcome comes from `on_error`, which defaults to `deny`. The decision is recorded with
`source: "fallback"` and carries no model judgement, so it is counted in the session stats but never
folded into the average risk and intent.

Denials name the cause and the attempt count so the agent can react rather than guess:

```
cruise-control denied this tool call (risk=high, intent=low): Classification unavailable
after 3 attempts (classification aborted); denied by fallback policy.
Retry with a safer, narrower tool call, or use the ask tool to request human review.
```

Set `on_error` to `"allow"` if you would rather a classifier outage not block your session. That is
a real trade-off: `deny` fails closed and can stall an agent when the endpoint is down, while
`allow` fails open and lets every tool call through for as long as the outage lasts.

## When the extension is not configured

The extension is inactive until a `cruise_control` key exists in a settings file, and inactive means
untouched — no classification, no logging, no blocking. Installing it never silently changes how
your tools run.

## When the model cannot be resolved

If `model` names something the registry does not have, or no model is selected at all, a warning is
shown once at session start naming what will happen to tool calls under the current `on_error`
setting. Classification then fails per call and takes the fallback path, without retrying, since no
number of attempts will conjure a missing model.

## What never fails a tool call

Two subsystems are deliberately best-effort, and their failures are swallowed:

- **Audit logging.** An unwritable log directory must not be able to stall or fail a tool call.
- **Command autocompletion.** A captured context goes stale across session replacement or `/reload`;
  reading a stale context throws, and completions are a convenience, so the read is guarded.

Everything else surfaces as a decision — an approval or a denial with a reason — rather than as an
exception, because a `tool_call` handler that throws blocks the tool with pi's own error text
instead of the feedback the agent needs.
