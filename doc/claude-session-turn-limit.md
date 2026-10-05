# Claude CLI session after a turn limit

A structured `error_max_turns` result ends the current invocation with
`max_turns_exhausted`. It retains a valid CLI session and its workspace identity
for the scheduler's next permitted continuation. This does not increase the
turn limit, schedule a retry, bypass quota checks, or change retry budgets.

A continuation still validates the saved workspace, prompt bundle, MCP identity,
and remote identity. Unknown sessions use the existing fresh-session fallback.
Poisoned previous-message IDs still clear the saved session. Explicit resets
still start fresh. A saved session does not guarantee a cache hit: provider
cache expiry remains independent of local session reuse.
