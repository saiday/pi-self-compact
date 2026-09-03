# pi-self-compact

A [pi](https://pi.dev) extension that lets the agent compact its own session context.

`/compact` is a TUI command, matched on the editor's submit text before anything reaches
the model, so an agent cannot trigger it, and neither can a prompt template, a skill, or
another session messaging in. This extension exposes the same compaction as a tool the
model can call and as a session-layer command.

## Why

- **Cross-session messaging.** The session that knows a context is bloated is usually not
  the one with a human in front of it. A peer session can now compact on request instead
  of relaying it back to a person.
- **Sequential task runs.** Auto-compaction fires on a token threshold, which lands
  mid-task. A task boundary is the right cut point, and only the agent knows when it
  reaches one, with the summary steered to what the next task needs.

## Install

```
pi install npm:pi-self-compact
```

From a checkout, without installing:

```
pi -e /path/to/pi-self-compact/extensions/index.ts
```

## Use

```
compact_session({ instructions: "keep the API schema decisions and the failing test names" })
```

```
compact_session({
  instructions: "keep the failing test names",
  resume: "Read docs/review.md and make the two changes it lists, then report back.",
})
```

```
/self-compact keep the API schema decisions
```

`instructions` steers what the summary preserves. `resume` is what the agent does next:
the text is delivered as a user message once the summary is in place, so the work runs
in a fresh turn against the compacted context. Both are optional. `/self-compact` is an
extension command dispatched at the session layer, so it works in RPC mode and anywhere
else a prompt can be submitted programmatically.

`resume` is what makes "compact, then do this" a single request. Without it a compaction
ends the session's activity, and something outside has to wake the agent up again.

## When compaction runs

`session.compact()` aborts the active turn before it summarizes, so a request made during
a turn is queued and runs once the agent settles: the tool returns immediately, the model
finishes its reply, then compaction runs. The summary is never visible in the turn that
requested it. `/self-compact` compacts immediately when the session is idle. A second
request while one is queued or running is refused rather than stacked. In TUI mode the
footer shows `compaction queued`, then `compacting…`.

A compaction that does not run reaches the model rather than only the UI: the agent is
told the context is unchanged, so it cannot report a compaction that never happened, and
a `resume` still runs. Pi refuses to compact a session smaller than its `keepRecentTokens`
setting (20k by default), which is the common reason.

A message that arrives while compaction is running is dropped by pi, so a peer asking for
a compaction should wait for the agent to answer before sending the next one.

## License

MIT
