/**
 * A small flight recorder for uploads.
 *
 * Everything that has gone wrong at this event has gone wrong on a phone, in a field, with
 * nobody able to attach a debugger — and by the time it is described the app has usually
 * been closed and reopened, which until now threw away the only evidence there was. So the
 * record is written to storage as it happens and survives being killed, and the whole thing
 * can be handed over as text.
 *
 * Deliberately dumb: a ring buffer of short lines. It has to be cheap enough to call from
 * inside the upload path without being part of why the upload is slow.
 */

const KEY = 'eventlens.log.v1';
/** Roughly a long evening of uploads, and well inside what storage will take. */
const CAPACITY = 600;
/** Writes are batched: a burst of thirty photographs must not be thirty storage writes. */
const FLUSH_MS = 1500;

export interface LogEntry {
  t: number;
  tag: string;
  msg: string;
}

let buffer: LogEntry[] = [];
let loaded = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let listener: (() => void) | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked (private mode, embedded webview)
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(KEY);
    if (raw) buffer = JSON.parse(raw) as LogEntry[];
  } catch {
    buffer = []; // corrupt or half-written; start clean rather than lose logging entirely
  }
}

function flush() {
  timer = null;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(buffer));
  } catch {
    // Out of room. Halving is better than dropping the mechanism: the recent lines are
    // the ones that explain what just happened.
    buffer = buffer.slice(-Math.floor(CAPACITY / 2));
    try {
      store.setItem(KEY, JSON.stringify(buffer));
    } catch {
      // Storage is simply unavailable. The log stays in memory for this session.
    }
  }
}

/**
 * Records one line. `tag` groups related lines (queue, http, app); `msg` is already
 * human-readable, because whoever reads this will be reading it on a phone.
 */
export function log(tag: string, msg: string) {
  load();
  buffer.push({ t: Date.now(), tag, msg });
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
  listener?.();
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

/** Called when the app is going away, so the last few lines are not the ones lost. */
export function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}

export function onLog(fn: (() => void) | null) {
  listener = fn;
}

export function entries(): LogEntry[] {
  load();
  return buffer;
}

export function clearLog() {
  buffer = [];
  loaded = true;
  flushNow();
  listener?.();
}

const two = (n: number) => String(n).padStart(2, '0');

function clock(t: number) {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** What the phone itself is, recorded once so a report explains which device it came from. */
export function deviceLine(): string {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const conn = (nav as unknown as { connection?: { effectiveType?: string; downlink?: number } })?.connection;
  const standalone =
    typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches
      ? 'installed'
      : 'browser';
  return [
    `ua=${nav?.userAgent ?? '?'}`,
    `mode=${standalone}`,
    conn?.effectiveType ? `net=${conn.effectiveType}${conn.downlink ? `/${conn.downlink}Mbps` : ''}` : '',
    `online=${nav?.onLine ?? '?'}`
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The whole record as text, ready to be pasted into a message. */
export function dump(): string {
  load();
  const lines = buffer.map((e) => `${clock(e.t)} [${e.tag}] ${e.msg}`);
  return [`EventLens log · ${new Date().toISOString()}`, deviceLine(), '', ...lines].join('\n');
}
