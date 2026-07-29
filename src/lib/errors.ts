/**
 * Failures the queue must not retry. Retrying a wrong passcode or a malformed request
 * just burns the whole backoff ladder on every photo and hides the real problem.
 */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/**
 * The server already has this photo confirmed. That means an earlier attempt actually
 * succeeded and only its response was lost — so this is a success, not a failure, and the
 * item should leave the queue quietly.
 */
export class AlreadyUploadedError extends Error {
  constructor(readonly id: string) {
    super(`already uploaded: ${id}`);
    this.name = 'AlreadyUploadedError';
  }
}

export const isNonRetryable = (e: unknown): e is NonRetryableError =>
  e instanceof NonRetryableError;

export const isAlreadyUploaded = (e: unknown): e is AlreadyUploadedError =>
  e instanceof AlreadyUploadedError;

/**
 * Maps an HTTP status from one of our endpoints onto retry behaviour.
 * 429 and 5xx are transient; 4xx means the request itself is wrong and will stay wrong.
 */
export function classifyStatus(status: number, where: string): Error | null {
  if (status === 429 || status >= 500) return new Error(`${where} failed ${status}`);
  if (status === 401 || status === 403) {
    return new NonRetryableError(`Λάθος ή ληγμένος κωδικός (${where}).`, 'unauthorized');
  }
  if (status >= 400) {
    return new NonRetryableError(`Μη έγκυρο αίτημα (${where} ${status}).`, 'bad_request');
  }
  return null;
}
