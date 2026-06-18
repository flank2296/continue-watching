// Continue Watching sync worker.
// Stores one encrypted blob per "key" (a hash derived from your passphrase) in KV.
// It never sees your passphrase or plaintext — the client encrypts before sending.
//
// Routes:
//   GET  /<key>  -> returns the stored ciphertext (empty string if none)
//   PUT  /<key>  -> stores the request body as ciphertext
//   OPTIONS      -> CORS preflight
//
// Bind a KV namespace as CW_KV (see wrangler.toml).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MAX_BYTES = 200_000; // generous ceiling; our payload is a few KB

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const key = url.pathname.replace(/^\/+/, '');

    // basic shape check: key is a 64-char hex SHA-256
    if (!/^[a-f0-9]{64}$/.test(key)) {
      return new Response('bad key', { status: 400, headers: CORS });
    }

    if (request.method === 'GET') {
      const val = await env.CW_KV.get(key);
      return new Response(val ?? '', {
        headers: { ...CORS, 'Content-Type': 'text/plain' },
      });
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.text();
      if (body.length > MAX_BYTES) {
        return new Response('too large', { status: 413, headers: CORS });
      }
      await env.CW_KV.put(key, body);
      return new Response('ok', { headers: CORS });
    }

    return new Response('method not allowed', { status: 405, headers: CORS });
  },
};
