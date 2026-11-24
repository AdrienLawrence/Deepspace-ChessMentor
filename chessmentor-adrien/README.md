# ChessMentor

A foresight-based chess coach built on the existing DeepSpace SDK 0.44.2 starter. Players can explore a position with a mentor before choosing their own move, then return to the same board, conversations, and annotations later.

## Product

- `/`: static introduction, without auth or record connections.
- `/home`: saved-game dashboard, ordered by recent activity.
- `/game/new`: White, Black, or Random; optional automatic move reflections.
- `/game/:id`: legal click-to-move gameplay, OpenAI opponent, conversational mentor, annotated board, move history, and resignation.
- `/game/:id/analysis`: read-only historical board, saved conversations and reflections, and new position-specific questions.
- `/settings`: existing account information and sign-out.

The board supports castling, en passant, captures, promotion/underpromotion, check, checkmate, stalemate, insufficient material, threefold repetition, and the fifty-move draw rule. The MVP automatically concludes claimable threefold/fifty-move draws. Closing the page does not resign. Earlier positions cannot submit moves; Return to Live restores gameplay.

## Architecture

React 19, TypeScript, Vite, Tailwind, and the starter's Base UI components provide the frontend. Hono and Cloudflare Workers host the backend. DeepSpace provides authentication, persistent SQLite records, reactive subscriptions, and the OpenAI proxy. `chess.js` is the deterministic rules library; **there is no chess-playing engine**. OpenAI chooses from server-generated legal candidates and the rules library validates the selected move.

| Module                                   | Responsibility                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/chess/types.ts`                     | Shared contracts and runtime command/annotation validation                                   |
| `src/chess/rules.ts`                     | Authoritative moves, replay, terminal conditions, historical positions                       |
| `src/chess/service.ts`                   | Owned game operations, inference orchestration, idempotency, serialization                   |
| `src/chess/ai.ts`                        | Mentor policy, output validation, OpenAI configuration                                       |
| `src/chess/conversation.ts`              | Stable question/answer ordering, including equal timestamps                                  |
| `src/chess/client.ts`                    | Authenticated action requests                                                                |
| `src/schemas/chess-schema.ts`            | Private, server-write-only game collections                                                  |
| `src/components/chess/Chessboard.tsx`    | Shared interactive board, promotion dialog, responsive annotation overlay, static thumbnails |
| `src/components/chess/GameWorkspace.tsx` | Live and analysis orchestration, separate viewed ply, recovery controls                      |
| `src/components/chess/MentorPanel.tsx`   | Persistent chat, saved feedback, annotated-message selection, retry                          |
| `src/components/chess/MoveHistory.tsx`   | Move list and navigation                                                                     |
| `src/chessmentor.css`                    | Responsive charcoal/sage interface and warm board                                            |
| `worker.ts`                              | App RecordRoom extension, serialized server operations, SDK record adapter, rate limit       |

### Gameplay data flow

1. The browser sends a validated command to `POST /api/actions/chess` with a DeepSpace bearer token.
2. The existing action route verifies the token and forwards the trusted identity to the app's single RecordRoom, using an internal-only path.
3. A per-owner queue inside that Durable Object serializes all chess operations. Other owners can proceed independently. All tabs belonging to an owner reach this same queue.
4. The service checks ownership, game status, expected revision, side to move, promotion, and legal moves. It reconstructs the full history so repetition detection is correct.
5. The browser previews the player's move optimistically while one SDK record upsert commits the complete game state. The preview is not treated as persisted until the operation succeeds; failures restore the authoritative position. SDK subscriptions propagate the update.
6. When the live page sees an opponent turn, it requests the opponent operation. Refreshing an interrupted game resumes this step. A selected AI move is validated before committing a new revision.

The RecordRoom queue is deliberately held across inference to prevent interleaved changes. It is local to the one Durable Object that owns the records, not a Worker-isolate lock. A restarted request reads durable records again: revisions prevent repeated moves, and deterministic record IDs prevent duplicate saved games, questions, answers, and feedback. An interrupted provider call can require another inference attempt, but it cannot append a second move to the same revision.

## Data and access

All collections use SDK record IDs and timestamps. JSON columns are serialized and decoded by the SDK.

| Collection      | Data                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `games`         | `playerId`, resolved `playerColor`, `automaticFeedback`, `currentFen`, `moveHistory`, `status`, `result`, `reason`, `version` |
| `game_messages` | `playerId`, `gameId`, `role`, `content`, `linkedPly`, `positionFen`, `annotations`, `status`, `requestId`                     |
| `move_feedback` | `playerId`, `gameId`, `ply`, `positionFen`, `summary`, `annotations`                                                          |

The starting position is ply 0, White's first move is ply 1, and Black's is ply 2. Each move stores SAN, UCI, actor, color, ply, and both FENs. Results are `*`, `1-0`, `0-1`, or `1/2-1/2`.

`playerId` is the immutable owner field. Member and admin reads are both `own`; anonymous/viewer reads are denied. Direct create, update, and delete are denied for **every client role**, including admin. That protects history and model-authored responses from WebSocket and assistant-tool writes. Server actions use the SDK's privileged record API and independently check ownership before every operation. The public Worker never forwards arbitrary requests to the internal chess path.

Commands are validated with Zod; chess request bodies are limited to 16 KiB. Durable admission allows 30 operations per user and 300 across the app per fixed minute, with at most five queued/in-flight operations per user and 30 across the app. AI attempts, including retries, are separately limited to 300 per user and 1,000 across the app per UTC day, plus shorter-window and concurrency limits. See `SECURITY_AUDIT.md` for the complete limits. There is no per-move question quota.

## AI behavior and billing

`createDeepSpaceAI(env, 'openai')` uses the existing DeepSpace proxy. It receives no caller-token override, so its documented default is `APP_OWNER_JWT`: inference is **developer-funded**. Players do not supply OpenAI API keys. The owner needs working DeepSpace authentication/configuration and sufficient platform credits. The raw browser OpenAI integration endpoint is denied so clients cannot bypass chess validation and throttling to spend owner credits.

The permitted model is `gpt-5.6-sol`, from the installed SDK's catalog. `CHESS_MODEL`, if set, must match this server-side allowlist; other values fail closed. Model calls have a 45-second timeout, an output-token bound, and no SDK automatic retries. Opponent selection allows at most two attempts; a failed turn offers Retry opponent and preserves the position.

The mentor receives the exact selected FEN, board matrix, player color, side to move, legal moves, ply, recent committed moves, and up to 16 bounded conversation messages. Live coaching emphasizes threats, relationships, consequences, and the player's own reasoning. Historical analysis and feedback may discuss concrete alternatives. It must not invent engine scores or assert unverified forced outcomes.

Coaching text and annotations are validated separately. Invalid annotation entries are discarded without losing otherwise usable text. The overlay accepts only arrows and square highlights with valid squares and red/blue/yellow/green semantic tones; no model-provided HTML is rendered.

Responses are presented after validation as completed messages, with pending/failed states and retry controls. **Token streaming is not implemented.** Completed messages and feedback are read from storage; navigation never invokes the model. Automatic feedback is optional and generated sequentially by an open live page; it resumes missing feedback on revisit, rather than running as a background job.

## Development

Use a Node/npm combination accepted by `package.json`; Node 24 and npm 11.6+ were used here.

```sh
npm ci --legacy-peer-deps
npm run login
npm run dev
```

Keep the existing app identity in `wrangler.toml`. The SDK supplies the environment used by the starter, including `DEEPSPACE_APP_ID`, `AUTH_JWT_PUBLIC_KEY`, `AUTH_JWT_ISSUER`, `AUTH_WORKER_URL`, `OWNER_USER_ID`, `APP_OWNER_JWT`, and the API/platform service bindings or local URL fallbacks. Optional security controls include `CHESS_AI_ENABLED`, `CHESS_AI_USER_DAILY`, `CHESS_AI_APP_DAILY`, and `CHESS_BLOCKED_USER_IDS`; see `SECURITY_AUDIT.md`. Keep credentials server-side and out of source-control additions.

The supplied checkout already tracks `.dev.vars` and local `.wrangler` state. The new `.gitignore` prevents new untracked runtime artifacts from being added; it does not remove files already tracked in the starter. Review those tracked files before sharing or pushing the repository. The app is deployed on its existing DeepSpace identity; no Git source push was performed.

```sh
npm run validate       # TypeScript and deterministic unit tests
npm run build          # Production Worker + frontend + prerendered landing; includes hook lint
npm run test:browser   # Production UI + application service, explicit service doubles
npm run test:worker    # Real local Worker/SQLite/WebSockets + mocked auth/OpenAI
npm run test:smoke     # Starter's live DeepSpace smoke tests
npm run test:e2e       # Starter's real-account tests
npm run format:chess   # Format chess source and test harnesses
```

Run `npm run build` before either integration script. Browser tests use installed Edge on Windows and Playwright's browser elsewhere. Override with `CHESS_TEST_BROWSER=chrome`, `msedge`, or `chromium` as available. Screenshots are written to ignored `test-results/screenshots/`. The browser fixture listens only on `127.0.0.1:5198`; the Worker fixture uses `127.0.0.1:5197`. Both use disposable synthetic identities and model responses, never real account credentials or billable inference. Test doubles exist only under `tests/`.

`test:worker` requires an OS-permitted `workerd` executable. Do not disable endpoint protection to run it; use an approved development environment. Real-account tests need an existing DeepSpace test-account pool (`npx deepspace test accounts --help`).

## Verification and limitations

See `ENGINEERING_REPORT.md` for the recorded results and remaining release checks. The checked implementation has passed TypeScript, deterministic tests, production builds, and browser workflows with explicit service doubles. Windows Application Control blocks local `workerd` on the current machine, and no DeepSpace test accounts are configured. Therefore real Worker persistence, live authentication, and actual OpenAI responses/billing have not been verified end to end here.

Other deliberate MVP limits: no ratings, clocks, puzzles, multiplayer, alternative chess engines, numerical engine evaluations, or advanced statistics. The model may make weak legal moves or imperfect educational judgments. Client subscriptions load complete game conversations; long-history pagination is a future scaling improvement. Operations for one owner queue behind one another during AI inference.

## Testing feedback update — November 23, 2026

### Remaining gameplay tickets

Current hosted app: https://chessmentor-ai.app.space (renamed from chessmentor-adrien; permanent app ID and saved data unchanged). Sign in again when first opening the new address. The local checkout and package name remain unchanged.

Player moves now display optimistically using the same chess rules as the server. While saving, board input, branching and questions are locked; opponent and feedback inference wait for confirmed records. A rejected request removes the preview and restores the latest confirmed position. The interface distinguishes saving from waiting for synchronization.

Desktop board size now responds to viewport height, with tighter spacing and a shorter move-history list. Material totals follow the displayed position, including historical positions, captures and promotions (pawn 1, knight/bishop 3, rook 5, queen 9; kings excluded). This is material balance, not an engine evaluation. The opponent has an elapsed timer and guidance after 10 and 25 seconds without attributing delay to move quality.

Opponent retries carry persisted rejected moves and validation reasons for the exact FEN/revision, including across reloads and manual retries. Successful moves clear that context. Automatic limits remain two generation calls per opponent request, zero SDK retries, and no automatic fallback. Billing/provider errors stop immediately. Each generation can incur charges; this does not provide provider-side exactly-once billing. The dashboard records rejection stages/counts without exposing moves. See `GAME_AUDIT.md` for the finished-game findings and coaching corrections.

### Owner diagnostics dashboard

Visit `/diagnostics` while signed in as the configured app owner. The navigation link appears for admins; server authorization requires the exact `OWNER_USER_ID`, so other admins cannot read diagnostics. The authenticated action and private Durable Object handler both check ownership. Responses are `no-store`, and telemetry lives in private Durable Object storage, not a client-readable record collection.

New chess requests persist a running snapshot and a final snapshot of the existing structured events. The dashboard refreshes every 30 seconds while visible (toggleable), supports time/operation/outcome/trace-ID filters, and shows request failure rate, AI latency and p95, attempts, reported input/output tokens, activity, failure reasons and expandable stage timings. Reads never trigger inference or create their own telemetry traces. Only whitelisted metadata is retained, with no prompts, answers, board positions, player identifiers or credentials.

The view includes at most the newest 500 request traces within seven days, with at most 60 stages per trace. Expired/excess records are pruned when traces are written; expired records are excluded from reads even when the app is idle. It is a bounded diagnostic sample, not a complete billing ledger. An unfinished snapshot older than two minutes is labeled incomplete, not failed. Intermediate stages become visible on completion. Extra attempts count generation attempts within a single request; manual retries have separate trace IDs. Earlier hosted console logs are not backfilled. No external telemetry service, alerts or new subscription is configured.

Traversing to the final ply restores live play in the active workspace. At historical positions where it is your turn, pieces can be moved to preview a branch. The source game stays unchanged. All saved messages and reflections appear in one timeline; clicking their text or position marker selects that board. Clear annotations sits above the board. The composer clears immediately, locks while submitting, shows a waiting state, and restores failed drafts with their original request ID and position. Completion updates scroll the conversation without moving the page.

To branch, visit an earlier position where it is your turn and play a different legal move. This previews the move and reveals a prominent **+ Create branch** button at the board's upper right. Click it to save and open the branch; Cancel or navigating away discards the preview. There is no branch disclaimer dialog. The server copies the exact prefix (preserving castling, en passant and repetition history), applies the replacement, and opens a separately owned game with the same player color and feedback preference. The original is unchanged. Branch requests are idempotent and owner-checked. Branches link to their original via additive `parentGameId` and `branchPly` fields. Conversations start fresh; automatic reflections only generate for moves after the branch point, avoiding rebilling for the copied prefix.

### AI diagnostics

`chess_trace` JSON log events correlate the server action, queue, record operations, model calls and final operation through a generated trace ID. Model events include purpose, model, latency, token usage, finish reason and safe provider request IDs on failures. They exclude prompts, response bodies and credentials. Failed requests expose the trace reference and use HTTP 402 (credits), 429 (provider rate limit), 504 (timeout), 503 (AI service/configuration/output) or 400 (other command failures), instead of all appearing as HTTP 200. Filter production logs with `npx deepspace logs --search <trace-id> --json`.

Credit, authentication, provider and timeout failures are not automatically retried. The opponent's second attempt is reserved for unusable model output. Failed questions stay saved and can be retried in place. Model selection and the 2,200-token allowance are unchanged pending funded quality evaluation. There is no automatic alternate-model fallback, billing top-up, tracing vendor, alerting service or new daily spend cap in this release.

The initial build was deployed to https://chessmentor-adrien.app.space and the user exercised real games and coaching. The current regression suite uses only synthetic local accounts and mocked AI; it does not spend platform credits. See the engineering report for current release checks.
