/**
 * Expected domain failures that may be safely returned to the player.
 * worker.ts translates these into HTTP status/retry information; unexpected errors stay generic.
 */

/** Only these explicitly safe messages may leave the server. */
export class ChessError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'invalid_request',
    public retryAfter?: number,
  ) {
    super(message)
    this.name = 'ChessError'
  }
}
