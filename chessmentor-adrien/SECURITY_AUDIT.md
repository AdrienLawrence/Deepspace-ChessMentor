# ChessMentor production security review

Review date: 2026-11-23 (America/New_York). Target: `chessmentor-ai.app.space`, permanent app ID `app_01M7VPKT5JCR90ZS8Z43ZFP5WS`. Code baseline was the existing uncommitted application atop commit `806aa7f`; this review preserves that work.

**Release assessment: do not give an unrestricted production sign-off until the exposed platform credentials have been revoked and replaced.** Application hardening substantially reduces abuse, but does not revoke credentials already committed to Git. No evidence of actual credential misuse was established by this review. Initial GitHub verification confirmed public exposure of commit `806aa7fa1f16f03f4e01bbbe6f2baadecefb32da`. On 2026-11-23 the repository was verified **private**, and an owner-authorized force-with-lease push removed that commit from `main`, returning the branch to `de81e244b40d7c5c56211fab162d5245e0df05be` before this clean application submission. Local app files were preserved and secret/runtime files excluded from the replacement commit. This does not purge GitHub caches, other refs or third-party copies. The exposed app identity token matched the local file. The exposed owner JWT differed from the current local JWT and expires **2036-11-18T04:47:30Z**; replacement alone does not establish revocation. Existing third-party copies/forks were not enumerated. The owner deferred credential rotation; it remains unresolved.

## Findings and disposition

| ID | Severity | Verified finding | Disposition |
| --- | --- | --- | --- |
| SEC-01 | Critical | `.dev.vars` contained an owner JWT and app identity token in publicly exposed commit `806aa7f`. The JWT's expiry is in November 2036. Local runtime databases were also tracked. | Repository made private; exposed commit removed from `main`; local secret/runtime files untracked and ignored, with source/build credential checks added. **Revocation and cleanup of any retained copies remain open.** |
| SEC-02 | High | The OpenAI HTTP block left other generic integration providers available to authenticated users under the default developer-billed policy. | Denied all browser-facing generic integration calls; model calls use only the guarded server-side chess boundary. Unknown integration configs also fail closed if the underlying helper is reused. No exploit against a paid live endpoint was attempted. |
| SEC-03 | High | A 30-request/minute per-user limit did not cap daily spending, total users, actual retry attempts or aggregate inference concurrency. | Added transactionally reserved persistent budgets at the provider boundary, a global concurrency lease, creation limits and pre-queue admission. A failure is counted conservatively; no silent refund or provider retry can bypass the budget. |
| SEC-04 | High | Starter realtime endpoints accepted arbitrary room identifiers and exposed unused canvas/Yjs/presence/cron/job surfaces; record frames lacked app-level byte/rate limits and session lifetime bounds. | Only the verified app RecordRoom is public. Authentication and origin checks, frame allowlist, bounded read queries, connection limits, heartbeat checks and expiry alarms added. Unused endpoints and binary/Yjs/mutation frames are denied. |
| SEC-05 | Medium | The SDK's default public identity roster could reveal other players' names, image URLs, roles and last-seen times despite own-record permissions. | Set `roster: 'read-policy'`, disabled unnecessary self-profile writes, and removed anonymous database connections. |
| SEC-06 | Medium | Paid chess actions checked identity and ownership but not current app membership; scoped service credentials and token expiry needed explicit regression coverage. | Require current member/admin membership. Verify user signatures/issuer with the SDK, require valid subject and expiration, reject scoped app credentials for browser actions, and support a configured blocked-user list. Billing credentials must match owner, app scope, signature and expiry before generation. |
| SEC-07 | Medium | Wildcard CORS, absent application security headers, oversized generic requests, raw unexpected error messages and GET logout increased exposure. | Same-origin browser/API policy, JSON/actual-byte limits, POST-only logout, CSP and other headers, safe error envelopes and structured security logs added. Production UI no longer displays raw exception text/stack. |
| SEC-08 | Low | npm reported the Windows esbuild development-server file-read advisory, affecting transitive esbuild 0.27.7. | Override updated to the patched 0.28.2 series; lockfile refreshed and build tested. npm install audit reported zero vulnerabilities. This was a development dependency risk, not evidence of a deployed exploit. |

## Enforced limits

The owner confirmed the daily limits during this review. These are **provider-attempt limits, not dollar guarantees**. Platform pricing, failed-call billing and external use of a stolen token are outside this accounting.

| Control | Limit |
| --- | --- |
| Chess operations, per user / whole app | 30 / 300 per minute, persistent, admitted before queueing |
| AI attempts per user | 12/minute, 120/hour, 300/day |
| AI attempts across the app | 30/minute, 1,000/day |
| Concurrent provider reservations | 4 app-wide; leases expire after 60 seconds if a process is lost |
| Queue | 5 pending/running operations per user; 30 app-wide |
| New games and branches | 10/hour and 30/day per user; 200/day across the app |
| HTTP API/agent input | 16 KiB actual bytes, independent of Content-Length |
| AI input/output | 64,000-byte prompt cap, fixed server-selected model, 2,200 output tokens, 45-second timeout; SDK automatic retries disabled |
| Opponent correction | At most 2 generations per operation; each reserves budget; at most 64 distinct rejected entries retained per position |
| Realtime | 8 KiB/frame, 120 frames/minute/connection including heartbeat, 6 connections/user, 200/app, up to 1,000 rows/query |
| Realtime session | No later than JWT expiration or 15 minutes, with an alarm to disconnect idle expired sessions |
| Cheap HTTP burst guard | 120 requests/minute/IP and 1,200/isolate, bounded memory; **not a distributed WAF** |
| Private trace retention | Most recent 500 traces, maximum 7 days |

Minute/hour/day counters use fixed UTC windows; a boundary can allow adjacent-window bursts. Durable Object storage transactions prevent cross-user reservation races. Reservation/storage failure stops inference. In-memory queue and cheap ingress guards are defense in depth; durable counters enforce inference spending across process eviction. Counters retain only compact per-account buckets rather than an unbounded history of requests.

## Trust boundaries checked

- Browser input never supplies a trusted user or app identity. Actions use verified bearer credentials; public websocket requests have identity and privileged headers replaced/removed. Internal action endpoints have no public forwarding route.
- Chess commands are Zod-validated, records are loaded and ownership compared before mutations or inference, and legal moves/revisions are checked by server-side chess.js. Direct SDK writes to chess collections are denied for member **and admin** roles. Actual SDK reads/writes were tested with an isolated SQLite database.
- Viewer/nonmember accounts cannot call paid chess actions. `CHESS_BLOCKED_USER_IDS` can deny known abusive accounts without relying on UI restrictions. Tools/MCP and diagnostics are owner-only; `security_status` returns counters and credential validity, never credentials.
- App actions intentionally bypass SDK RBAC internally; their explicit ownership checks remain essential. New privileged actions must repeat those checks rather than assuming the tool layer authorizes ownership.
- AI has no executable tools, shell, network destinations or database-write authority. Its output is parsed into bounded text/annotations or a legal move. User and model text is rendered through React escaping, not HTML injection. Prompt instructions are not treated as an authorization control.
- OAuth return targets are based on the receiving app origin; exchange failures now produce safe log events. Session cookies are HttpOnly, Secure and SameSite=Lax. Identity-provider state validation, code replay protection, session revocation and sign-in throttling are platform responsibilities and were not independently penetrated.
- User JWTs follow the installed DeepSpace issuer-wide identity contract rather than inventing an incompatible app-specific audience. App authorization is then checked separately. Local owner tools retain the SDK's target-origin-bound agent token verification.
- No client bundle credentials or public source maps were found by the added checker. This is pattern/value matching, not proof that every possible secret format is absent.

## Logs, diagnostics and incident response

HTTP/API failures produce structured `security` events with a generated request ID and route category. Action result logs include an opaque hash of the authenticated user, status and chess trace ID. Denied origins, request bursts, malformed/limited socket frames and OAuth exchange failures have explicit codes. Request bodies, Authorization/Cookie headers, OAuth codes, query strings, private prompts and raw provider responses are not added to application logs. Unexpected errors return a generic explanation; known domain failures retain safe, actionable messages and appropriate status codes. HTTP 429 responses include Retry-After where a durable limit provides a reset time.

`/diagnostics` remains strictly owner-only and no-store. It now shows daily usage limits and verifies the configured billing credential without making an inference request. The signature check does **not** establish revocation status or available credit balance. Traces include inference timings, tokens, failure classifications and retry stages; they are not a billing ledger.

Useful read-only operational commands:

```sh
npx deepspace logs --since 1h --search security --limit 100 --json
npx deepspace agent tools chessmentor-ai --json
# Discover the security_status schema first, then invoke it with an empty input object.
npm run security:check
npm run validate
npm run build
npm run test:browser
npm audit
```

Runtime controls in `wrangler.toml` / deployed configuration:

- `CHESS_AI_ENABLED="false"`: stop new AI reservations while preserving games and normal non-AI actions. In-flight requests may finish.
- `CHESS_AI_USER_DAILY` / `CHESS_AI_APP_DAILY`: nonnegative integer attempt budgets; zero blocks new attempts. Invalid configuration fails closed. Apply through a deployment; do not publish credentials in config.
- `CHESS_BLOCKED_USER_IDS`: optional comma-separated exact user IDs; use a private deployed configuration value when needed. No secret key belongs in this setting.

For a suspected credential exposure: stop additional spending through the platform, preserve minimal incident evidence privately, request revocation of the exposed app-scoped owner token(s) and app identity token, provision replacements, deploy, and verify the old credentials are rejected. Do not put token values in tickets/chat/logs. Then coordinate removing the credential-bearing Git history from the remote and other copies. **Untracking, deleting the current file, minting another JWT, or deploying again does not prove revocation.** The installed CLI and reviewed docs did not expose a supported revocation command for these reserved credentials. This review did not guess an undocumented mutation or force-rewrite shared history.

## Remaining production work and limits of assurance

1. **Blocker — credential revocation:** obtain platform confirmation and a safe rejection check for the old credentials. The exposed commit was removed from `main` at the owner's request, but retained objects, other refs and external copies were not purged. Do not treat the branch rewrite as revocation.
2. **Spend exposure:** set a platform/account dollar ceiling and credit alerts if supported. The app's request budgets are useful but do not bound all account-level billing. Multiple malicious signups can exhaust the shared allowance and deny AI service to legitimate users.
3. **Monitoring:** structured logs and the dashboard exist; no external log drain, alert destination or on-call notification channel was configured. Add alerts for 5xx/402/429 spikes, invalid credentials, repeated blocked actions and quota utilization. Frontend crashes are not centrally collected by a dedicated error-monitoring service.
4. **Recovery and data lifecycle:** app code/release rollback exists; a production data backup/restore drill, retention/deletion policy and account-deletion procedure were not established. Agree an acceptable recovery point and exercise restore in a separate environment before promising durability to users.
5. **Platform/identity controls:** confirm edge DDoS/WAF and authentication abuse controls, Google OAuth production consent/access settings, owner MFA, collaborator access and credential/session revocation semantics with DeepSpace. SDK websocket tokens travel in query parameters; application logs avoid URLs, but platform-level URL redaction should be confirmed.
6. **Release process:** no branch protection or CI security gate was configured. Run the checked-in source/build scanner and tests before release; wire them into the repository's release pipeline. Do not roll back to a release that restores generic billing routes.
7. **Runtime coverage:** Windows Application Control still blocks local workerd, so the full Cloudflare emulator was not bypassed. Tests use real app routes, SDK authorization and SQLite with simulated storage/transport, plus browser tests using explicit service doubles. Alarm scheduling/hibernation and distributed edge behavior need staging/load validation. No destructive production tests, real provider generations or multi-account load tests were run.
8. **Scope:** this is a focused source review and bounded verification of this app, not a certification of DeepSpace, Google, Cloudflare, every dependency, or all possible attack paths. No guarantee of zero vulnerabilities is implied.

## References

The review used the installed SDK as the version-specific authority, plus [DeepSpace integration billing guidance](https://docs.deep.space/guides/external-apis), [DeepSpace secret management](https://docs.deep.space/guides/secrets), [OWASP REST security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), [OWASP WebSocket security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html), and [Cloudflare static-asset headers](https://developers.cloudflare.com/workers/static-assets/headers/). Static assets receive `_headers` rules and Worker responses receive equivalent middleware headers.

## Verification and release evidence

TypeScript and 139 tests across 12 files passed, including 42 new security cases using real application routes, SDK authorization, signed test credentials and an isolated SQLite database. All 18 browser scenarios passed with the CSP headers enforced. The production build, source/client credential checker and whitespace check passed. Final npm audit reported 0 vulnerabilities at every severity. AI generation was doubled in tests; no paid AI requests were made.

Deployed security release `rel_01M85TBVN28W799SRR259SZ7T3` at https://chessmentor-ai.app.space. Edge confirmation succeeded. The CLI's anonymous data-plane readiness probe was `unverifiable` because anonymous room access is now denied. Separate authenticated owner verification succeeded: the live `security_status` tool returned the configured 300-user/1,000-app daily limits, zero new counted attempts and a valid app-scoped billing credential. A live WebSocket using the existing CLI user's credential successfully performed an owned-game read and heartbeat. No game mutation or inference was used. Full emulator/hibernation limitations remain as described above.

Live bounded probes passed for unauthenticated actions/diagnostics, generic OpenAI and Anthropic routes, uploads, debug SQL, unused payment proxy, agent auth, internal-path spoofing, arbitrary rooms and anonymous app-room access. `.dev.vars` and `worker.ts` URLs returned 404, GET logout returned 405, cross-origin requests were denied, and public responses carried the configured security headers. A fresh guest browser displayed the protected-route sign-in screen and Google sign-in button with no runtime errors; it did not complete a real OAuth login. Scripts: `scripts/security-live-probe.mjs` and `scripts/security-live-socket.mjs`.
