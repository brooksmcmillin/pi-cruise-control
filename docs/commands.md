# Commands

```
/cruise-control                        show effective configuration
/cruise-control stats                  session counters and averages
/cruise-control model <provider/id>    set the classifier model
/cruise-control reasoning <level>      set the reasoning level
```

`model` and `reasoning` write to the **global** settings file, preserving every other key in it, and
take effect immediately — there is no need to restart the session. Both offer argument completion:
`reasoning` from the six thinking levels, `model` from the models your providers currently expose.

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
