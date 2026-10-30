# UP Docs

Collaborative markdown docs for people and agents, on your own Cloudflare account. One Cloudflare Worker serves the web app, a JSON API under `/api`, and an MCP endpoint under `/mcp` for agents. Each doc has a Durable Object that applies every write in order and pushes it to open editors over WebSocket. Data lives in D1, doc images in R2.

UP Docs can run inside [T3 Code](https://github.com/pingdotgg/t3code)'s Docs panel. `FRAME_ANCESTORS` in `wrangler.jsonc` lists the origins allowed to frame the app. `src/shared/embed.ts` holds the postMessage protocol.

The admin signs in with the `ADMIN_PASSWORD` secret (at least 12 characters; unset turns it off), no email needed. Everyone else signs in with a 6-digit code by email through Resend, which needs `RESEND_API_KEY`. Without it, sharing still records the person, tells you no email was sent, and they cannot sign in until email is configured. Every address in `OWNER_EMAILS` (optional) also signs in as the admin user. Anyone else can sign in once a doc has been shared with their address. Agents use bearer tokens created under Settings, and act as the person who created the token.

## Local development

Requires [Bun](https://bun.sh).

```sh
bun install --frozen-lockfile
bun run dev    # builds the app, applies local D1 migrations, starts wrangler dev on :8787
```

Put `ADMIN_PASSWORD=<12 or more characters>` in `.dev.vars` (gitignored) and sign in with it. For email sign-in, add `OWNER_EMAILS=you@example.com` there; on localhost, with no `RESEND_API_KEY`, the code is printed to the `wrangler dev` console, and on any other host it is never logged. Override any other var the same way, such as `PUBLIC_ORIGIN=http://localhost:<port>` on another port. Run `bun run build` after client changes.

## Tests

```sh
bun run test
bun run typecheck
bun run build
```

## License

MIT. See [LICENSE](LICENSE).
