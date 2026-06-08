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
