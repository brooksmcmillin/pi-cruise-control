# Commands

```
/cruise-control                        show effective configuration
/cruise-control on                     classify tool calls
/cruise-control off                    let every tool call through unclassified
/cruise-control stats                  session counters and averages
/cruise-control model [provider/id]    pick from available models, or set one directly
/cruise-control reasoning <level>      set the reasoning level
```

Everything except `stats` writes to the **global** settings file, preserving every other key in it,
and takes effect immediately — there is no need to restart the session.

## on / off

`off` writes `enabled: false`; `on` writes `enabled: true`. Running `on` when no `cruise_control`
section exists yet creates one, which is the quickest way to start: the extension becomes active
with the built-in default rules, and you can refine them afterwards.

Because the write lands in the global file, a project file that sets `enabled` outranks it. When
that happens the command says so rather than reporting a state change that did not take effect:

```
Wrote enabled=false globally, but this project's .pi/settings.json overrides it. Still on here.
```

## model

With no argument, `model` lists the models whose providers have resolved auth — the same set pi
treats as usable — and marks the current one:

```
cruise-control classifier model
  anthropic/claude-sonnet-4-5
  deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731  (current)
  openai/gpt-5
```

Cancelling changes nothing. Passing a name directly (`/cruise-control model openai/gpt-5`) skips the
picker, which also lets you name a model that is not available yet — useful when you are about to
log in to that provider. Both forms warn if the resulting model cannot be resolved.

Argument completion is available on both: `reasoning` from the six thinking levels, `model` from the
same available-model list.

With no argument, the command reports the configuration actually in force, which is the quickest way
to confirm that a project override landed:

```
cruise-control - configuration
  status     active
  model      ollama-cloud/deepseek-v4-flash
  reasoning  low
  timeout    20000ms per attempt, on failure: deny
  retry      up to 2 retries, backoff 500-4000ms
  parallel   unlimited
  cache      on, ttl 30m, 12/500 entries
  log        on, 30d retention, /home/you/.pi/agent/cruise-control
  rules      background 3, allow 3, conditional 3, deny 4
```

## Stats

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

Counters reset at every session start, so the numbers always describe the session in front of you
rather than the process.

Averages cover model and cache decisions only. A `fallback` carries no model judgement — its risk
and intent are assigned by the failure policy, not by the classifier — so it is counted in the
totals but never folded into the averages. Levels are scored `low: 1`, `medium: 2`, `high: 3`, and
the label in parentheses is the nearest level to the mean.

`by tool` reads as approved over total. Two further lines appear only when the counters are
non-zero: `retries` and `queued`.
