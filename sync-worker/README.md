# cw-sync — Cloudflare Worker for Continue Watching sync

A tiny Cloudflare Worker + KV namespace that stores one **end-to-end-encrypted** blob per
user. The extension/userscript encrypts the watch history with your passphrase (AES-GCM)
before uploading, so this worker only ever stores ciphertext and never sees your passphrase.

- **Live URL:** `https://cw-sync.ankushgochke.workers.dev`
- **KV namespace id:** set in `wrangler.toml` (`94d87bd096454f279f1f53aefa28f3e2`)

## How it works

The client derives a 64-char hex key = `SHA-256("cw-key-id:" + passphrase)` and calls:

| Method | Path | Action |
|---|---|---|
| `GET` | `/<key>` | return the stored ciphertext (empty if none) |
| `PUT` | `/<key>` | store the request body as ciphertext (max 200 KB) |
| `OPTIONS` | any | CORS preflight |

Keys that aren't 64-char hex are rejected with `400`. CORS is open (`*`) so the browser
extension and the userscript can both reach it.

## Files

```
sync-worker/
├── worker.js       # the worker (GET/PUT + CORS, KV-backed)
├── wrangler.toml   # name, entry, compatibility date, KV binding
└── README.md       # this file
```

## Deploy / redeploy

Requires Node. From this folder:

```sh
npx wrangler login                       # log into your Cloudflare account
# first time only — create the KV namespace and paste its id into wrangler.toml:
npx wrangler kv namespace create CW_KV
npx wrangler deploy                      # prints the workers.dev URL
```

To push code changes later, just re-run `npx wrangler deploy`.

## Cost

Free tier is plenty for personal use:

- **Workers:** 100,000 requests/day (you'll use a few hundred).
- **KV:** 100,000 reads/day, **1,000 writes/day**, 1 GB storage.

The 1,000 writes/day KV limit is the tightest; a couple of devices syncing a small list stay
well under it.

## Privacy

The worker stores only ciphertext and a hashed key. Without the passphrase, the data can't
be decrypted and can't be tied to you. Losing the passphrase means the synced copy can't be
recovered — keep a local **Export** as backup.
