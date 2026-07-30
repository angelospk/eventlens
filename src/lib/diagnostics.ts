import { createQueueStorage } from './idb-store';
import { detectOutputFormat, nativeWebp, wasmWebp, loadPreference } from './image-format';
import type { AuthHeaders } from './session';
import type { FetchLike } from './types';

/**
 * Works out why photographs are not arriving.
 *
 * Every step is exercised for real rather than inferred. The upload check in particular
 * signs and PUTs an actual object, because the only failure that matters is the one that
 * happens on the wire, and it is the step no amount of feature detection can predict.
 *
 * The test object is deliberately never confirmed through /meta, so it stays a pending row:
 * invisible on the wall, invisible to the manager, and reusing one id per day means a night
 * of anxious retries leaves one stray thumbnail-sized object rather than hundreds.
 */
export type CheckState = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

export interface Diagnosis {
  checks: Check[];
  /** Set when a different encoder would plausibly fix what is broken. */
  suggestion?: 'jpeg' | 'webp';
}

/**
 * Browser network failures surface as "Failed to fetch" or "Load failed", which tells a
 * photographer nothing. Anything unrecognised is passed through rather than invented.
 */
function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|load failed|networkerror|network request failed/i.test(raw)) {
    return 'Δεν έφτασε στον διακομιστή. Έλεγξε το δίκτυο και ξαναδοκίμασε.';
  }
  return raw;
}

export interface DiagnoseDeps {
  workerUrl: string;
  auth: AuthHeaders;
  eventDate: string;
  fetchImpl?: FetchLike;
}

/** A 2x2 image, encoded through the same path a photograph takes. */
async function tinyEncoded(mime: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(2, 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#4f52e0';
  ctx.fillRect(0, 0, 2, 2);
  const blob = await canvas.convertToBlob({ type: mime, quality: 0.8 });
  if (blob.type === mime) return blob;
  if (mime === 'image/webp') {
    const { default: encodeWebp } = await import('@jsquash/webp/encode');
    const buf = await encodeWebp(ctx.getImageData(0, 0, 2, 2), { quality: 80, method: 0 });
    return new Blob([buf], { type: mime });
  }
  throw new Error(`ο browser δεν παρήγαγε ${mime}`);
}

export async function diagnose(deps: DiagnoseDeps): Promise<Diagnosis> {
  const f = deps.fetchImpl ?? fetch;
  const checks: Check[] = [];
  let suggestion: Diagnosis['suggestion'];

  // --- 1. Is there a network at all, as far as the browser knows.
  checks.push(
    navigator.onLine
      ? { name: 'Δίκτυο', state: 'ok', detail: 'Η συσκευή βλέπει σύνδεση.' }
      : {
          name: 'Δίκτυο',
          state: 'warn',
          detail: 'Η συσκευή λέει ότι είναι εκτός σύνδεσης. Οι φωτογραφίες περιμένουν στη σειρά.'
        }
  );

  // --- 2. Local storage: without it the queue lives only in memory.
  try {
    const storage = await createQueueStorage();
    checks.push(
      storage.ephemeral
        ? {
            name: 'Τοπική αποθήκευση',
            state: 'warn',
            detail:
              'Δεν είναι διαθέσιμη, οπότε η ουρά κρατιέται στη μνήμη. Μην κλείσεις τη σελίδα ' +
              'πριν ανέβουν όλες. Συχνά φταίει μια δεύτερη ανοιχτή καρτέλα της εφαρμογής.'
          }
        : { name: 'Τοπική αποθήκευση', state: 'ok', detail: 'Η ουρά επιβιώνει κι αν κλείσει η σελίδα.' }
    );
  } catch (e) {
    checks.push({
      name: 'Τοπική αποθήκευση',
      state: 'warn',
      detail: e instanceof Error ? e.message : 'Δεν είναι διαθέσιμη.'
    });
  }

  // --- 3. Which encoder this device can actually run.
  const pref = loadPreference();
  const [hasNative, hasWasm] = await Promise.all([nativeWebp(), wasmWebp()]);
  const format = await detectOutputFormat();
  const how = hasNative ? 'από τον ίδιο τον browser' : hasWasm ? 'μέσω WebAssembly' : 'δεν υποστηρίζεται';
  if (pref === 'webp' && !hasNative && !hasWasm) {
    checks.push({
      name: 'Μορφή',
      state: 'warn',
      detail: 'Ζήτησες WebP αλλά η συσκευή δεν μπορεί να το παράγει. Χρησιμοποιείται JPEG.'
    });
    suggestion = 'jpeg';
  } else {
    checks.push({
      name: 'Μορφή',
      state: 'ok',
      detail:
        format.ext === 'webp'
          ? `WebP, ${how}. Μικρότερα αρχεία, πιο γρήγορο ανέβασμα.`
          : 'JPEG. Μεγαλύτερα αρχεία, αλλά δουλεύει παντού.'
    });
  }

  // --- 4. Encode something for real and time it.
  let encodeOk = false;
  try {
    const t0 = Date.now();
    const blob = await tinyEncoded(format.mime);
    encodeOk = blob.size > 0;
    checks.push({
      name: 'Επεξεργασία',
      state: 'ok',
      detail: `Δοκιμαστική εικόνα σε ${Date.now() - t0}ms.`
    });
  } catch (e) {
    checks.push({
      name: 'Επεξεργασία',
      state: 'fail',
      detail: humanError(e)
    });
    // A broken encoder is exactly the case where changing format helps.
    suggestion = format.ext === 'webp' ? 'jpeg' : 'webp';
  }

  // --- 5. Credentials.
  let authed = false;
  try {
    const res = await f(`${deps.workerUrl}/auth`, { headers: await deps.auth(), cache: 'no-store' });
    authed = res.ok;
    checks.push(
      res.ok
        ? { name: 'Κωδικός', state: 'ok', detail: 'Ο διακομιστής τον δέχεται.' }
        : {
            name: 'Κωδικός',
            state: 'fail',
            detail:
              res.status === 429
                ? 'Πολλές αποτυχημένες προσπάθειες. Περίμενε ένα λεπτό.'
                : 'Απορρίφθηκε. Κάνε έξοδο και ξαναμπές.'
          }
    );
  } catch {
    checks.push({
      name: 'Κωδικός',
      state: 'warn',
      detail: 'Δεν απαντά ο διακομιστής. Μάλλον είναι το δίκτυο, όχι ο κωδικός.'
    });
  }

  // --- 6. The whole upload path, for real.
  if (authed && encodeOk) {
    try {
      const id = `doctor-${deps.eventDate}`;
      const t0 = Date.now();
      const signRes = await f(`${deps.workerUrl}/sign`, {
        method: 'POST',
        headers: { ...(await deps.auth()), 'content-type': 'application/json' },
        body: JSON.stringify({ id, eventDate: deps.eventDate, originalName: 'doctor', ext: format.ext })
      });
      if (!signRes.ok && signRes.status !== 409) throw new Error(`υπογραφή ${signRes.status}`);
      if (signRes.status === 409) {
        checks.push({
          name: 'Ανέβασμα',
          state: 'ok',
          detail: 'Ο διακομιστής απαντά κανονικά.'
        });
      } else {
        const { uploadUrl } = (await signRes.json()) as { uploadUrl: string };
        const blob = await tinyEncoded(format.mime);
        const put = await f(uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': format.mime },
          body: blob
        });
        if (!put.ok) throw new Error(`αποστολή ${put.status}`);
        checks.push({
          name: 'Ανέβασμα',
          state: 'ok',
          detail: `Δοκιμαστικό αρχείο ανέβηκε σε ${Date.now() - t0}ms.`
        });
      }
    } catch (e) {
      checks.push({ name: 'Ανέβασμα', state: 'fail', detail: humanError(e) });
    }
  }

  return { checks, suggestion };
}
