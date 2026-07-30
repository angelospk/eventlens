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

/**
 * The request never reached the server: no signal, a captive portal, a dead hotspot. Kept
 * separate from a server error because the advice to the photographer is different, and
 * because it is the normal case at an outdoor festival rather than an exception.
 */
export class NetworkError extends Error {
  readonly code = 'network';
  constructor(where: string) {
    super(`network unreachable (${where})`);
    this.name = 'NetworkError';
  }
}

export const isNetworkError = (e: unknown): e is NetworkError => e instanceof NetworkError;

export const isNonRetryable = (e: unknown): e is NonRetryableError =>
  e instanceof NonRetryableError;

/**
 * A sentence the photographer can act on, instead of the raw failure. They are standing in
 * a field at night; "put failed 500" tells them nothing about whether to wait, retry, or
 * find the person with the passcode.
 */
export function describeError(e: unknown): string {
  if (isNetworkError(e)) return 'Δεν έφυγε — χωρίς σύνδεση. Θα ξαναδοκιμάσει μόνο του.';
  if (isNonRetryable(e)) {
    switch (e.code) {
      case 'unauthorized':
        return 'Ο κωδικός δεν ισχύει πια. Κάνε έξοδο και ξαναμπές.';
      case 'process_failed':
        return 'Η φωτογραφία δεν διαβάστηκε. Δοκίμασε άλλη μορφή αρχείου.';
      default:
        return 'Ο διακομιστής απέρριψε τη φωτογραφία.';
    }
  }
  const text = e instanceof Error ? e.message : String(e);
  // Anything the browser throws from fetch lands here as a TypeError with a vague message.
  if (/fetch|network|load failed/i.test(text)) {
    return 'Δεν έφυγε — χωρίς σύνδεση. Θα ξαναδοκιμάσει μόνο του.';
  }
  return 'Κάτι πήγε στραβά στην αποστολή. Θα ξαναδοκιμάσει μόνο του.';
}

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
