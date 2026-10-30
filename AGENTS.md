# UP Docs

Collaborative markdown docs on Cloudflare Workers, D1 and Durable Objects. Tooling is Bun, Vite, Vitest, wrangler.

## Commands

- `bun install --frozen-lockfile`: install. New dependencies need the owner's approval; `bunfig.toml` refuses packages younger than 7 days.
- `bun run dev`: build, apply local D1 migrations, start `wrangler dev` on :8787.
- `bun run test`, `bun run typecheck`, `bun run build`.
- `bun run deploy`: build, apply remote D1 migrations, deploy. Needs a POSIX shell.
- `ADMIN_PASSWORD=... bun scripts/smoke.ts <url>`: end-to-end check of a deployed app. Only against a test deployment; it removes what it creates.
- `scripts/scan-public.sh`: secret and identity scan of the working tree. Add `--all-refs` to cover all history. Run it before any push.

## Rules

- Wire values of the embed protocol never change: postMessage type strings, meta names, event names and field names stay byte-identical, including those with `t3` in them. T3 Code ships separately and matches them exactly. `src/worker/embedWire.test.ts` pins them; fix the code, not the test. Additive optional fields are allowed only after reading the T3 Code parser that receives them.
- `FRAME_ANCESTORS` in `wrangler.jsonc` stays as it is unless the owner asks.
- The default names are Worker `up-docs`, D1 `up-docs`, R2 `up-docs-images`. Never change a default to `docs-cloud`: those names belong to a separate production deployment on the same account, and using them would deploy over it.
- Migrations are append-only. Never renumber or rename an applied file.
- `src/host/` holds modules copied from t3code, shared in shape with the host. Each file names its source commit in its header. Keep their wire values unchanged.
