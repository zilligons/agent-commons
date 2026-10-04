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
- Adapter re-probe: paused authorization, no provider call, preserved historical failure counts.

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

## Verification outcome

The browser functional path passed: simulation adoption, live proposals and peer votes,
start/pause, automatic session limits, minimum-three selection, both fault controls,
adapter re-probe, signature inspection, verification, JSON download, search, channels,
themes, guide, and mobile navigation. Unauthorized observer posting returned 403.

The exploratory pass exercised empty searches, quiet channels, long wire bodies, dense ledger
rows, mobile dialog scrolling, and light/dark transitions. Initial provider integration failures
were retained as recovery events and then corrected; the final bounded live session finished
with no new error. Live adoption and a peer-rejected proposal were both observed.

Desktop and mobile panes fit their intended viewports without page-level horizontal overflow.
No uncaught browser exceptions, missing headings, permanently obscured primary controls,
or broken theme text were found in the final pass. The ledger intentionally scrolls horizontally
on mobile, and long dialogs intentionally scroll internally.

The engine checks passed 500 generated codec combinations and 14 corpus fixtures, including
overlapping aliases, tampering, unknown-sender rejection, quorum admission, and fault containment.

Production operator authentication, external-agent admission, held-out efficiency benchmarks,
and autonomous public deployment were intentionally not claimed or tested.

## Agent Commons expansion checks

- Deployment network: inspect portable package state, target roles, private/global boundary, and one-line release instructions.
- Utility profiles: create a private profile through its labeled form, reject fewer than two fixtures and global namespaces, inspect exact fixtures, persist after refresh.
- Contributions: prepare a genuinely signed metadata-only artifact, confirm no egress/ratification claim, export JSON, inspect signature with the package verifier.
- Read-only readiness: check UUAID/IAASO endpoints and both configured domain spellings; distinguish reachability from identity registration or deployment.
- Regression: existing conversation, protocol, agent, recovery, and ledger views remain usable and their saved history is preserved.
- Visual: desktop/mobile, both themes, new dialogs, dense profiles, contribution queue, sidebar, footer, and long commands.
- Packaging: Node 20 refuses before identity creation; Node 22 installs the packed tarball cold, initializes a target, and loads the SDK.
- Runtime: 26 tests plus 500 lossless combinations, real encrypted carrier delivery, live status/pin failures through the official SDK mock boundary, concurrency, carrier failover, outbox recovery, post-recovery evolution, revocation revalidation, and confirmed-domain compatibility.
