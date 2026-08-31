# TeleVecha Engineering Rules

## Bug reports and `.tvbug` replay

- Do not make a replay pass by changing expected output to match the current implementation.
- Do not add report-specific branches, IDs, peers, timing exceptions, screenshots, or compatibility fallbacks.
- Do not treat the recorded transport call order as the product behavior that must be preserved. A fix may legitimately change which read-only requests are made or their order.
- Preserve the captured external facts: Telegram state, server responses, update order, user actions, and timing when timing is relevant. Replay the client against those facts so a fixed implementation is allowed to behave differently.
- Keep mutations and causal user actions strict. Model read-only Telegram queries as order-independent reads from captured server state where possible; an unexpected mutation must still diverge.
- Treat `.tvbug` replay compatibility as a tested public contract. A refactor that adds, removes, combines, or reorders read-only transport calls must not make existing reports useless when those reports contain the required server facts.
- When changing a transport read interface, add a replay compatibility regression showing that an older captured report still reproduces against the new read pattern.
- If the report lacks enough external data to reproduce the issue faithfully, say that the report format or collection is incomplete and fix collection. Do not synthesize the missing fact merely to obtain a passing replay.
- Use the newest relevant `.tvbug` to identify the exact failure before changing production code. Add a fail-first regression that reproduces the same state transition, then implement the fix.
- A prevention test is not enough when existing persisted state can already be corrupt. Add and verify a recovery test as well.
- Do not describe a feature request as a bug. Track requested behavior separately from defect fixes and test each against its stated requirement.
