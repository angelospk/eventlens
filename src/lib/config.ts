export const config = {
  // Cloudflare Worker base URL (set per environment via PUBLIC env in real deploy)
  workerUrl: import.meta.env?.VITE_WORKER_URL ?? 'http://localhost:8787',
  // logo path is resolved against the SvelteKit base path at call sites (see processor):
  logoFile: 'logo.png',
  avif: { quality: 70, effort: 5 },
  // Brand color grade applied via canvas filter string:
  filter: 'contrast(1.05) saturate(1.12) brightness(1.02)',
  // Logo sizing/padding as fraction of the image's short edge:
  logoWidthFraction: 0.18,
  logoPaddingFraction: 0.03,
  // Optional downscale cap (disabled by default to preserve resolution):
  maxLongEdge: 0 as number, // 0 = no cap
  // Upload retry policy:
  retry: { baseMs: 1000, maxMs: 30000, maxAttempts: 8 }
};
