// Prerender every route to static HTML so GitHub Pages serves each path directly
// (e.g. /manager) instead of 404ing on non-root paths. Pages render their initial
// (logged-out) state at build time; client hydration handles the rest.
export const prerender = true;
