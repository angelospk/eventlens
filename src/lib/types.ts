export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * What the clients actually need from fetch. Narrower than `typeof fetch` on purpose: the
 * real global carries extra members (Bun adds `preconnect`), so an inline arrow function or
 * a test mock would not satisfy it.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface Pixels {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export type ItemStatus =
  | 'pending'
  | 'processing'
  | 'uploading'
  | 'done'
  | 'error';

export interface QueueItem {
  id: string;            // uuid, also the R2 filename stem
  file: Blob;            // source file (kept until upload confirmed)
  originalName: string;
  eventDate: string;     // YYYY-MM-DD
  status: ItemStatus;
  attempts: number;
  // Epoch ms when the photo was picked. IndexedDB returns rows ordered by key, and the key
  // is a uuid, so without this the queue uploads in effectively random order and the wall
  // shows the night out of sequence.
  queuedAt?: number;
  lastError?: string;
  nextAttemptAt?: number; // epoch ms; item is not retried before this (backoff without blocking the queue)
  // populated after processing:
  avif?: Blob;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface Processed { avif: Blob; width: number; height: number; bytes: number; }

// Sent to /meta. The server already knows r2_key/public_url from /sign;
// the client only confirms the upload + reports dimensions.
export interface PhotoMeta {
  id: string;
  original_name: string;
  width: number;
  height: number;
  bytes: number;
}

// Returned by /sign.
export interface SignResult { uploadUrl: string; publicUrl: string; key: string; }

// Where a confirmed photo stands with the manager. Separate from upload `status`: a photo
// can be fully uploaded and still not be public.
export type Moderation = 'pending' | 'approved' | 'hidden';

// Returned by GET /list — one confirmed photo's metadata for the manager grid.
export interface PhotoListItem {
  id: string;
  public_url: string;
  original_name: string | null;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
  moderation: Moderation;
}

// One night's settings. `autoApprove` is the per-event switch: on = photos go public the
// moment they land, off = the manager approves each one.
export interface EventSettings {
  date: string;
  title: string | null;
  autoApprove: boolean;
}

// --- Photo Wall (sub-project 4) ---

// One confirmed photo as returned by the public GET /wall endpoint (minimal shape).
export interface WallPhoto {
  id: string;
  public_url: string;
  created_at: string;
}

// A sponsor slot, defined in static/sponsors.json.
export interface Sponsor {
  type: 'message' | 'image';
  text?: string;        // for type 'message'
  imageUrl?: string;    // for type 'image'
  durationMs?: number;  // falls back to opts.defaultSponsorMs if absent
}

// A single entry the wall player renders. buildPlaylist() produces Slide[].
export interface Slide {
  kind: 'photo' | 'message' | 'image';
  src?: string;         // photo/image URL
  text?: string;        // message text
  durationMs: number;
  key: string;          // stable key for {#each}
}
