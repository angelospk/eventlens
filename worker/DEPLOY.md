# Worker deploy (requires Cloudflare login)
bunx wrangler login
bunx wrangler d1 create eventlens            # paste returned database_id into wrangler.toml
bunx wrangler d1 migrations apply eventlens --remote
bunx wrangler secret put PASSCODE
bunx wrangler secret put R2_ACCOUNT_ID
bunx wrangler secret put R2_ACCESS_KEY_ID
bunx wrangler secret put R2_SECRET_ACCESS_KEY
# set PUBLIC_BASE + ALLOWED_ORIGIN in wrangler.toml [vars] first
bunx wrangler deploy
# Then configure R2 bucket CORS to allow PUT from the app origin.

## R2 bucket CORS (browser PUT)
Set the bucket CORS to allow PUT from the exact deployed app origin (same value as ALLOWED_ORIGIN), not "*":

[{ "AllowedOrigins": ["https://REPLACE.github.io"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]

## Frontend env
The app reads the Worker URL from VITE_WORKER_URL at build time (falls back to http://localhost:8787 for local dev).
For the GitHub Pages build, set VITE_WORKER_URL to the deployed Worker URL — either as a repo Actions variable wired into the build step, or hardcode it in src/lib/config.ts before deploy.
Also set the [vars] PUBLIC_BASE and ALLOWED_ORIGIN in wrangler.toml to the real R2 public base and the GitHub Pages origin before `wrangler deploy`.

Define the VITE_WORKER_URL Actions repository variable in GitHub → Settings → Secrets and variables → Actions → Variables so the CI build picks it up automatically.
