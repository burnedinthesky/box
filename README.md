# embox

A file-sharing site running on Cloudflare Workers and R2. Uploads expire after 24 hours.

## Features

- Parallel R2 multipart uploads with automatic part retries
- Multi-thread downloads via HTTP Range requests
- Drag and drop, upload/download progress, and dark mode
- Collision-safe object keys, including files with identical names
- Files become unavailable 24 hours after upload completion
- Scheduled deletion every 15 minutes, backed by R2 lifecycle rules

## Local development

```bash
pnpm install
pnpm dev
```

Wrangler uses local R2 storage by default; local development does not write to the production bucket.

```bash
pnpm build
pnpm test
pnpm prettier --check .
```

Build before running the integration tests. Tests run the bundled Worker against local R2, including multipart uploads, byte-range downloads, and expiry with a controlled clock.

## Cloudflare deployment

The configuration in `wrangler.jsonc` deploys Worker `box`, serves `public/`, and binds `UPLOADS` to R2 bucket `box-uploads`. A cron trigger runs cleanup every 15 minutes.

In Cloudflare **Workers & Pages → box → Settings → Builds**, connect GitHub repository `burnedinthesky/box` using **Workers Builds**:

| Setting           | Value                       |
| ----------------- | --------------------------- |
| Production branch | `main`                      |
| Root directory    | `/`                         |
| Build command     | `pnpm build && pnpm test`   |
| Deploy command    | `pnpm exec wrangler deploy` |

Cloudflare installs dependencies using the committed pnpm lockfile. Pushes to `main` trigger builds and deployments through Cloudflare's Git integration. The existing GitHub Actions workflow only runs checks; it does not deploy.

For a manual deployment:

```bash
pnpm run deploy
```

### Bucket lifecycle rules

Configure these once in the same Cloudflare account (already provisioned for this deployment):

```bash
pnpm exec wrangler r2 bucket lifecycle add box-uploads expire-uploads-24h uploads/ --expire-days 1
pnpm exec wrangler r2 bucket lifecycle add box-uploads expire-sessions-24h sessions/ --expire-days 1
pnpm exec wrangler r2 bucket lifecycle add box-uploads abort-incomplete-24h uploads/ --abort-multipart-days 1
```

The Worker refuses expired downloads and excludes expired files from the list at 24 hours. Physical deletion normally follows at the next 15-minute cron run. R2 lifecycle deletion is a fallback and may run later. Abandoned upload sessions expire after 24 hours; incomplete multipart uploads are aborted during cleanup or by the lifecycle rule.

Files use 8 MiB parts, up to 10,000 parts (78.125 GiB per file). Downloads stream from R2, although the browser's multi-thread downloader assembles the file in browser memory. The interface is public: anyone with access to the site can list, upload, and download files.

## Credits

Based on [embox by Elvis Mao](https://github.com/elvisdragonmao/embox). Quicksand font by [Andrew Paglinawan](https://www.fontsquirrel.com/fonts/quicksand).
