# Caching

Only **low-risk** verdicts are cached. Repeating a `read` or an `ls` is the common case, and a cache
hit there saves a model round trip per tool call. Anything the classifier rated medium or high is
re-judged every time, because the intent half of the verdict depends on prompts that keep moving —
an action that was a plausible next step three turns ago may be unrelated to what the user is asking
for now.

## Keys

An entry is keyed by three things:

1. The tool name.
2. The tool arguments, serialized with object keys sorted, so argument order never splits one
   logical call into two cache entries.
3. A fingerprint of the classifier model plus the four instruction lists.

The fingerprint is what makes editing the rules safe: changing `model` or any `instructions` list
produces a new fingerprint, so every previously cached approval becomes unreachable rather than
outliving the policy that produced it. There is no need to clear anything by hand after a settings
edit.

## Eviction

Entries expire after `cache.ttl_ms` and the map is bounded at `cache.max_entries`, evicting least
recently used first — a hit moves its entry to the back of the queue. Set `cache.enabled` to `false`
to classify every call fresh; switching it off also drops whatever is currently held.

The cache lives in memory for the life of the process and is never written to disk. Nothing about a
tool call survives a restart except the audit log.
