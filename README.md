# pi-self-compact

A [pi](https://pi.dev) extension that lets the agent compact its own
session context.

`/compact` is a TUI command: pi matches it on the editor's submit text before anything
reaches the model, so an agent cannot trigger compaction on its own, and neither can a
prompt template, a skill, or another session messaging in. This extension exposes the same
compaction through the extension API, as a tool the model can call and as a command.

## Why an agent needs this

Compaction is normally something only the person at the keyboard can do, and the two
moments it is most needed are moments nobody is typing.

**Another session asks for it.** With cross-session messaging, sessions delegate work to
each other, and the session that knows a context is bloated is usually not the one with a
human in front of it. Ask a peer session to compact without this extension and the honest
answer is that it cannot: it can only relay the request back to a person. With it, the
peer compacts and carries on, and the requesting session gets a real confirmation instead
of a hand-off.

**A run of sequential tasks.** An agent working through a queue accumulates the whole
history of task 1 while doing task 7, and none of it is relevant. Auto-compaction does not
help much here: it fires on a token threshold, which lands wherever it lands, usually in
the middle of something. A task boundary is the right cut point, and the agent is the only
one who knows when it reaches one. "Compact after each batch, keeping the migration
decisions" becomes an instruction it can actually follow, with the summary steered to what
the next batch needs rather than to a generic recap.

## Install

```
pi install npm:pi-self-compact
```

Or run it from a checkout without installing:

```
pi -e /path/to/pi-self-compact/extensions/index.ts
```

## Use

The model calls the `compact_session` tool:

```
compact_session({ instructions: "keep the API schema decisions and the failing test names" })
```

`instructions` is optional and steers what the summary preserves.

The same thing manually, where the argument is those instructions:

```
/self-compact keep the API schema decisions
```

Unlike `/compact`, `/self-compact` is an extension command, which pi dispatches at the
session layer rather than in the TUI. It works in RPC mode and anywhere else a prompt can
be submitted programmatically.

## When compaction actually runs

Requests are queued and run once the agent settles, not at the moment of the call.
`session.compact()` aborts the active turn before it summarizes, so compacting from inside
a tool call would kill the turn that asked for it.

So the sequence is: the tool returns immediately, the model finishes its reply, the turn
ends, compaction runs. The summary is never visible in the turn that requested it. A
second request while one is queued or running is refused rather than stacked.

## Behavior worth knowing

- Compaction is lossy. Detail outside the summary and the kept recent messages is gone.
- pi refuses to compact a session that is too small, or one already compacted with nothing
  new since. That surfaces as an error notification, not a silent no-op.
- The footer shows `compaction queued` and then `compacting…` in TUI mode.
- Compaction settings (reserved tokens, how much recent context to keep) come from pi's
  own `compaction` settings; this extension does not override them.

## Requirements

pi 0.84 or newer, for the `compact()` extension context method and the `agent_settled`
event.

## License

MIT
