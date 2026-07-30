export const config = {
  // Cloudflare Worker base URL (set per environment via PUBLIC env in real deploy)
  workerUrl: import.meta.env?.VITE_WORKER_URL ?? 'http://localhost:8787',
  // logo path is resolved against the SvelteKit base path at call sites (see processor):
  logoFile: 'logo.png',
  // Encoder quality, 0-100. Everything ends up as WebP: natively where the browser can,
  // and through a WebAssembly encoder on Safari, which cannot encode WebP from a canvas
  // and whose JPEG ran about five times larger per megapixel. The old AVIF encoder was
  // dropped because it took roughly ninety seconds per photo; WebP is seconds.
  quality: 78,
  // Brand colour grade, applied as a pixel transform inside the worker. It used to be a
  // canvas `filter` string, which Safari does not support — the grade silently vanished
  // on every iPhone upload.
  grade: { contrast: 1.05, saturate: 1.12, brightness: 1.02 },
  // Fraction of the photo's WIDTH. Judged by eye on a 2560px frame: below this the dates
  // and the small line under the wordmark turn to mush, above it the mark starts competing
  // with the photograph instead of signing it.
  logoWidthFraction: 0.17,
  // Margin from the edge, as a fraction of the short edge.
  logoPaddingFraction: 0.03,
  // Long-edge cap. Full-resolution phone photos blow past the per-tab memory budget on
  // iOS during decode + encode, and nothing downstream (wall, phones, downloads) gains
  // anything from more than this.
  maxLongEdge: 2560 as number, // 0 = no cap
  // The gallery shows tiles a few hundred pixels wide, on screens up to 3x density. Below
  // this they go soft on a good phone; above it, the page weight climbs for nothing.
  thumbLongEdge: 640 as number, // 0 = no thumbnails
  thumbQuality: 70,
  // Upload retry policy:
  retry: { baseMs: 1000, maxMs: 30000, maxAttempts: 8 }
};
