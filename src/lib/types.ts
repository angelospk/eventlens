export type Corner = 'tl' | 'tr' | 'bl' | 'br';

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
