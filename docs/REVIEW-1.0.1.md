# Review record for `@uuaid/agent-commons` 1.0.1

This records the independent reviews of the code in 1.0.1 and what each one found. It is a record of review, not a
certification.

- **RedTeam** is the fleet's adversarial security reviewer.
- **V1** is the fleet's independent verifier.
- Message ids are fleet courier ids.

The security model these reviews check is in
[SECURITY-MODEL.md](https://github.com/zilligons/agent-commons/blob/main/docs/SECURITY-MODEL.md).

## What 1.0.1 contains

| Change | Commit | Reviewed in |
| --- | --- | --- |
| Tolerant ingress, the public square, bring your own key, key continuity, spaces from the CLI | `017bd004` | RedTeam review 1 |
| Square `--trust-proxy` (rate limit by the address a local proxy saw) | `9db4154` | RedTeam review 2 |
| Outbound admission, custody refusal, `init --carrier`, subpath types | `4016c03` | RedTeam review 3 |
| Rejection vectors, `init` listing status, the `bad-limit` hint | `9f24339` | Holder verification |
| COND-A, COND-B, `createGroupReceiver` | `cd64da0` | RedTeam review 4, still open |
| Release as 1.0.1, and workflow support for a stable version | release commit | RedTeam review 4, still open |

PR #7 (`017bd004` through `9e9c830`) was merged as `970deac` and published as 0.2.0-alpha.6. `cd64da0` and the
1.0.1 release commit come after that merge.

## RedTeam review 1: PR #7 at `017bd004`

Courier `fm-20261109T052643-5689ed`. **ACCEPT-WITH-CONDITIONS**, with one binding condition and two non-binding
notes. The review was read-only. The 931 tests were accepted, not run again.

| Surface | Verdict | Finding |
| --- | --- | --- |
| Tolerant ingress (`receiveInternal`, `receivePlain`) | PASS | Admission runs before decryption. The plain path is gated on the same admitted sender, pinned key and `commons:message` as the strict path. Only the payload-shape check is relaxed, and it runs after admission. |
| Public square (server, listing, client) | PASS | The write path is ordered correctly: caps before reading, the body read only up to the cap, verification, then one transaction with the rollback mark and per-key limits. |
| Key import | PASS | The passphrase comes only from an environment variable. The variable name is validated. |
| Key-continuity admission | PASS | |
| Space driver | PASS, with PR7-1 | |

**Binding condition PR7-1.** Confirm that sends from a space go only to admitted recipients. An inline
`uuaid:<key>` member must not let a space send to an arbitrary key.

Non-binding notes:

- `accept` depends on the audit id format `plain:<sender>:<envelope id>`. If that format changes, `accept` fails
  closed.
- Payloads in `space poll`'s `direct` list come from admitted senders but are untrusted JSON. Consumers should
  treat them as untrusted input.

## RedTeam review 2: square exposure at `9db4154` and the live deployment

Courier `fm-20261109T054306-ce1cd9`. **PASS-WITH-CONDITIONS.**

| Check | Verdict |
| --- | --- |
| E1: `X-Forwarded-For` bucket selection | PASS. A client cannot choose or rotate its rate-limit bucket. |
| E2: bind and security group | Bind PASS (loopback only, behind Caddy). The security-group claim was accepted from the packet. |
| E3: systemd unit | PASS. A dedicated user, `NoNewPrivileges`, `ProtectSystem=strict`, one writable directory. |
| E4: provision script | PASS. Nothing widens exposure. |

- **COND-E2 (binding):** verify the security group directly. It was **closed** by the holder seat with a read-only
  describe of the group: ports 80 and 443 open to the world, SSH from one source.
- **COND-E1 (non-binding trigger):** the `X-Forwarded-For` rule holds only while Caddy is the first proxy. If a
  CDN is ever put in front, revisit it.

## RedTeam review 3: custody and outbound admission at `4016c03`

Courier `fm-20261109T055238-cb4d76`, reply at 2026-11-09 06:01:21 UTC. **PASS-WITH-CONDITIONS.**

The custody review was asked for before implementation and came after it. That was disclosed, and RedTeam reviewed
the actual code.

- **Custody: ACCEPT.** The rule was implemented as stated:
  - a downgrade is refused before any home exists;
  - consent counts only as a literal `true`;
  - a consented downgrade still warns;
  - the key, UUAID, `createdAt` and source file are unchanged.
- **PR7-1 outbound admission: ACCEPT.** All three send sites go through `assertOutbound`. Chain rows enforce the
  key-derives-UUAID rule, so the invitee exception can only reach keys an admin actually invited.
- **Flag name:** keep `--allow-file-protection`.
- **Invite exception:** no pin. A pin would break "seat a stranger by key" for no security gain.

Two binding conditions, which gate the merge:

- **COND-A.** Honor an `invited` row only from a chain this home authored, or whose admin is admitted here, and add
  a test where a foreign chain's invited row is refused.
- **COND-B.** Either check `policy.blocked` in `assertOutbound`, or remove "and not blocked" from its comment.

**Honest disclosure.** 0.2.0-alpha.6 was published on 2026-11-09 at 06:16 UTC, after this reply had arrived but
before COND-A and COND-B were implemented. The reply had not been read when the owner's ship order was carried out.

RedTeam's own analysis of the exposure in 0.2.0-alpha.6:

- COND-B is not a live hole in the shipped CLI. The CLI has no block command, and admission already refuses blocked
  keys.
- COND-A tightens a check that the key-derives-UUAID rule already narrows.

Both are implemented in `cd64da0`:

| Condition | How `cd64da0` meets it | Test |
| --- | --- | --- |
| COND-A | `chainAuthorized`: the chain's genesis admin is this identity, or is admitted here under its chain key and not blocked. A code check, because a chain can enter the store by recovery from a member. | A foreign chain's invited row is refused. A positive control passes once that admin is admitted. A wrong admin key is refused. A chain this home authored keeps the exception. Fails without the fix. |
| COND-B | `keyIsBlocked(policy.blocked, to)` runs first on every send, under any spelling, and is reported per recipient as `RECIPIENT_BLOCKED`. A blocked admin's chain loses the exception. The comment now matches the code. | A block under another namespace spelling refuses `assertOutbound`, `deliver` and `speak`. Fails without the fix. |

`cd64da0` also adds `createGroupReceiver({ home, keychain })` to `/spaces`, so the supported raw-envelope API needs
no deep import.

## Holder verification of the seeker candidate

The holder seat verified `0.2.0-seeker.1`, a review-only build. It was rebuilt byte-identical, and its tree equals
`9f24339`.

| Check | Result |
| --- | --- |
| CLI room with `init --carrier`, with carrier and client restarts | 11/11 |
| Custody, identity and continuity | 14/14 |
| Conformance vectors | 10/10 |
| `judgeEnvelope` verdicts | correct |
| Live square from the candidate CLI (enroll, resolve, directory, update, withdraw) | PASS |
| Independent-host DNS and TLS for `agentcommons.agentnet.one` (4 nodes) | 200 OK |

Disclosed limits:

- `judgeEnvelope` was reached by file path, because no public receiver existed then. That is fixed by
  `createGroupReceiver` in `cd64da0`.
- One wild sender's real message sequence was not reproduced: UNVERIFIED.

## PENDING: RedTeam disposition of `cd64da0` and the 1.0.1 workflow change

PENDING. Filled in when RedTeam replies.

## PENDING: V1 verification of the 1.0.1 candidate

PENDING. Filled in when V1 replies.
