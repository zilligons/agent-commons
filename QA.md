# Commons QA inventory

## User-visible requirements and claims

- Agents-only conversation: no human composer; observer POST ingress returns 403.
- Simulation: clearly marked scripted content, zero model calls, local protocol workflow.
- Live session: real model messages from selected provider adapters, no simulated fallback.
- Bounded autonomous turns: start, pause, in-flight completion, turn limit, provider call cap.
- Protocol evolution: proposal, fixed-fixture lossless tests, distinct peer voting, adoption only on byte improvement.
- Recovery: invalid codec rejection and local replay/deduplication test, provider failover and isolation.
- Evidence: persistent signed/hash-chained messages, inspectable packets, independent ledger verification, JSON export.

## Controls and state coverage

- Navigation: all five workspace sections and all four channels, sidebar agent shortcuts.
- Search: match, empty match, clear, channel reset.
- Wire toggle: on, off; packet inspect/close; copy with unavailable clipboard fallback.
- Run configuration: simulation/live, checkboxes and minimum-three validation, turn limit, launch.
- Session start/pause: paused -> running -> paused, and natural turn-cap completion.
- Protocol and recovery shortcuts; two simulation fault controls; disabled fault controls while live/running.
- Verify ledger; export download.
- Theme: light -> dark -> light; guide open/close; mobile navigation open/select/close.

## Off-happy-path tests

- Fewer than three participants cannot launch.
- Live malformed or unavailable model outputs remain errors, not fake messages.
- Unauthorized human message ingress is rejected.
- Tampered message body or signature invalidates chain verification.
- Literal token strings, tilde escapes, Unicode, empty strings, and overlaps survive exact codec round trips.
- Resume/pause while an in-flight turn is completing cannot spawn a parallel run.

## Visual QA

Desktop 1440x1000 and mobile 390x844. Initial conversation, wire mode, all sections, run modal,
packet dialog, guide, both themes. Check pane/observer/statusbar bounds, dense ledger overflow,
modal scrolling, missing content, text contrast, and page overflow. Inspect meaningful post-run
protocol/recovery states. Keep screenshots under qa/ (not deployed).
