# UP Docs

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/riccardovandra/up-docs)

Collaborative markdown docs for people and agents, on your own Cloudflare account. One Cloudflare Worker serves the web app, a JSON API under `/api`, and an MCP endpoint under `/mcp` for agents. Each doc has a Durable Object that applies every write in order and pushes it to open editors over WebSocket. Data lives in D1, doc images in R2, or in D1 if you remove the R2 binding. Uploaded videos always live in R2.

UP Docs can run inside [T3 Code](https://github.com/pingdotgg/t3code)'s Docs panel. `FRAME_ANCESTORS` in `wrangler.jsonc` lists the origins allowed to frame the app. `src/shared/embed.ts` holds the postMessage protocol.

## Deploy

### Before you click

- **R2 may need a payment method.** Images go to an R2 bucket by default, and Cloudflare may require a payment method on the account before it creates one. We have not confirmed this on an account with no card. If the deploy fails on the R2 bucket, either add a payment method, or remove the `r2_buckets` line from `wrangler.jsonc` and deploy again. Images are then stored in D1, and uploading videos is turned off.
- **Choose an admin password** of 12 or more characters. Shorter or empty turns password sign-in off, and with no email set up you then cannot sign in at all.

### What the button does

The button itself has not been pressed in testing. These steps were run through the same Workers Builds service with the same commands, and the setup page is described from Cloudflare's documentation.

1. Cloudflare copies this repo to your GitHub or GitLab account, and asks for the project and Worker names, the resource names, and `ADMIN_PASSWORD`.
2. It prefills the build command and deploy command from `package.json`. Keep them, for example `bun run build` and `bun run deploy`. The deploy command needs a POSIX shell, which the Workers Builds image has.
3. Workers Builds installs with `bun install --frozen-lockfile`, builds, creates the D1 database and R2 bucket, applies the migrations, and deploys.
4. On the first deploy the log shows `Couldn't find a D1 DB`, marked as an error. This is expected: the database does not exist until the deploy creates it. The build continues and ends with `Success! Build completed`.

Your app is live at `https://<worker>.<your-subdomain>.workers.dev`. Sign in there with the password.

### After deploying

- **Add agents.** In the app, open Settings and create an API token. In T3 Code, open Settings -> MCP servers and add `https://<your-worker-url>/mcp` with that token. Agents act as the person who created the token.
- **Add email, for invites and other people's sign-in.** Without it, sharing still records the person and tells you no email was sent, and they cannot sign in until email works. To add it, verify a domain in [Resend](https://resend.com/domains), then in the Worker's settings add the secret `RESEND_API_KEY` and the variable `EMAIL_FROM`, such as `UP Docs <docs@example.com>`. Both are needed: with only the key, the app reports email as not configured and sends nothing. Deploys keep values set in the dashboard.
- **Sign in as admin by email (optional).** Set the variable `OWNER_EMAILS` to a comma-separated list of addresses. Anyone else can sign in once a doc has been shared with their address.
- **Use a custom domain (optional).** Add it to the Worker, then set the variable `PUBLIC_ORIGIN` to its origin, such as `https://docs.example.com`. Unset, the app uses the origin of each request.
- **Embedding.** `FRAME_ANCESTORS` in `wrangler.jsonc` controls who may frame the app. The default allows T3 Code and its local origins.

### Deploy with Wrangler

Requires [Bun](https://bun.sh) and a POSIX shell, so on Windows use WSL.

```sh
git clone https://github.com/riccardovandra/up-docs
cd up-docs
bun install --frozen-lockfile
bunx wrangler login
bun run deploy
bunx wrangler secret put ADMIN_PASSWORD
```

`bun run deploy` builds, applies migrations and deploys, creating the D1 database and R2 bucket when they are missing. The same `Couldn't find a D1 DB` message appears on the first run.

### Check a deployment

```sh
ADMIN_PASSWORD=<password> bun scripts/smoke.ts https://<your-worker-url>
```

It signs in, creates and edits a doc, uploads an image and a video, uses `/mcp` with a new API token, checks sharing, then removes what it created. The sharing step fails when email is configured, because it expects no email to be sent.

### Videos

A doc plays YouTube links, Loom links and uploaded MP4, WebM and MOV files. In the editor, use "Video link" or "Upload video" in the "+" menu, or drop a file on the page. Agents write a `t3-video` block, whose first line is the source and whose optional second line is the title:

````
```t3-video
https://www.youtube.com/watch?v=dQw4w9WgXcQ
Release walkthrough
```
````

- YouTube and Loom load only when a reader clicks play. Nothing contacts them before that.
- Uploads need R2. Without the bucket the API answers `video_storage_unavailable` and the editor says so. Links still work.
- Files are capped at 1 GiB and go through the Worker in 50 MiB parts. They use the `IMAGES` bucket under a `videos/` prefix, so there is nothing extra to configure.
- Removing a video block does not delete the file. Files go when the doc is deleted. R2 storage costs about $0.015 per GB-month, and egress is free.
- Inside T3 Code, fullscreen and player autoplay need T3 Code to pass `fullscreen; autoplay` to the docs iframe. Until that ships, videos play there with these two limits.

### Cloudflare plan limits

UP Docs has not been tested on the Workers Free plan, so we do not claim it works there. Free allows 10 ms of CPU per request, and we measured, on a single account whose plan limits we did not verify, with a 10 MiB image:

| Image store | Upload CPU   | Fetch CPU         |
| ----------- | ------------ | ----------------- |
| R2          | 7 to 16 ms   | 1 to 2 ms         |
| D1          | 49 to 133 ms | not measured here |

Both uploads can exceed the 10 ms limit, the D1 path by far, so expect large image uploads to be at risk on Free. Smaller images use less. R2 and D1 have their own usage limits; check Cloudflare's current pricing.

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
