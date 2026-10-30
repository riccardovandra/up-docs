# UP Docs

Collaborative markdown docs for people and agents, on your own Cloudflare account. One Cloudflare Worker serves the web app, a JSON API under `/api`, and an MCP endpoint under `/mcp` for agents. Each doc has a Durable Object that applies every write in order and pushes it to open editors over WebSocket. Data lives in D1, doc images in R2.

UP Docs can run inside [T3 Code](https://github.com/pingdotgg/t3code)'s Docs panel. `FRAME_ANCESTORS` in `wrangler.jsonc` lists the origins allowed to frame the app. `src/shared/embed.ts` holds the postMessage protocol.

Sign-in is a 6-digit code by email through Resend. Every address in `OWNER_EMAILS` signs in as the admin user. Anyone else can sign in once a doc has been shared with their address. Agents use bearer tokens created under Settings, and act as the person who created the token.

## Local development

Requires [Bun](https://bun.sh).

```sh
bun install --frozen-lockfile
bun run dev    # builds the app, applies local D1 migrations, starts wrangler dev on :8787
```

Sign in as `owner@example.com`. The code is printed to the `wrangler dev` console. Override any var in `.dev.vars` (gitignored), such as `OWNER_EMAILS=you@example.com`, or `PUBLIC_ORIGIN=http://localhost:<port>` on another port. Run `bun run build` after client changes.

## Tests

```sh
bun run test
bun run typecheck
bun run build
```

## License

MIT. See [LICENSE](LICENSE).
