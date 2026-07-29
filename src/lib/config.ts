export const config = {
  // Cloudflare Worker base URL (set per environment via PUBLIC env in real deploy)
  workerUrl: import.meta.env?.VITE_WORKER_URL ?? 'http://localhost:8787',
  // logo path is resolved against the SvelteKit base path at call sites (see processor):
  logoFile: 'logo.png',
  avif: { quality: 70, effort: 5 },
  // Brand colour grade, applied as a pixel transform inside the worker. It used to be a
  // canvas `filter` string, which Safari does not support — the grade silently vanished
  // on every iPhone upload.
  grade: { contrast: 1.05, saturate: 1.12, brightness: 1.02 },
  // Logo sizing/padding as fraction of the image's short edge:
  logoWidthFraction: 0.18,
  logoPaddingFraction: 0.03,
  // Long-edge cap. Full-resolution phone photos blow past the per-tab memory budget on
  // iOS during decode + encode, and nothing downstream (wall, phones, downloads) gains
  // anything from more than this.
  maxLongEdge: 2560 as number, // 0 = no cap
  // Upload retry policy:
  retry: { baseMs: 1000, maxMs: 30000, maxAttempts: 8 }
};
