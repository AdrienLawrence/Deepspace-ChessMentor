# Finished game audit — November 23, 2026

White won by **64. Qg7#**, after 127 half-moves. A local chess.js replay verified every UCI/SAN move, before/after FEN, side to move, actor, ply number and final revision. No earlier position was terminal. The stored final position and checkmate result agree with the replay.

The saved history contains **127 distinct move reflections** and **14 questions with 14 completed answers**. All coaching records reference the correct historical board. No missing reflection, duplicate reflection ply, pending answer or failed answer was found in this game's final saved state. These checks establish persistence and position consistency, not the truth of every coaching sentence.

## Coaching findings

The reflection on Black's final move, `63…Kh8`, incorrectly called it forced. The legal moves before it were `Kh8` and `Kh6`. That same reflection gave away `Qg7#` while the game was still live. The final checkmate explanation itself correctly identified the queen on g7 being defended by the king on f6.

The next release supplies verified pre-move legal alternatives and a `wasOnlyLegalMove` flag to feedback requests. The instructions distinguish alternatives to the move being reviewed from the player's next move; live feedback must not prescribe that next move, including mate. This improves grounding but is not a guarantee of model accuracy. No engine search or paid AI evaluation was used. Existing coaching is preserved rather than regenerated.

## Retry, latency and usage review

Before this update, the second illegal-output attempt received the original position without the rejected move. The revised flow persists rejection history against the game's exact revision and FEN before another attempt. Automatic and later manual retries receive the cumulative list and validation reasons. Duplicate rejected moves are not duplicated in that list. A successful move clears the history; branches and later positions start clean. Server validation and per-owner serialization still prevent duplicate committed moves.

Each generation is still a new paid provider call. There are at most two automatic attempts per opponent request; malformed/illegal output can use the second. Billing, authentication, rate-limit and timeout errors stop without that retry. The SDK's own automatic retries remain disabled. Each call retains a 45-second timeout and 2,200-token output allowance. There is no silent fallback model or engine, and no new subscription. Manual retries can spend again. A crash after provider completion but before persistence can still lead to repeated billing on recovery; cumulative rejection context is not provider-side exactly-once billing.

Operations for one owner share a server queue. A move can therefore wait behind an in-flight coaching request. Optimistic display addresses the visible delay while keeping authoritative commits and AI requests gated on confirmed state. The opponent timer measures the user's total request wait, including queue time; it does not claim that a long wait proves a good move.

Telemetry began near the end of this game and is bounded to recent retained requests. It cannot establish the entire game's paid request count, total cost, or whether earlier long waits were caused by repeated illegal outputs. Raw records and audit scripts remain in ignored `test-results/`; no credentials or chat text are included in this report.
