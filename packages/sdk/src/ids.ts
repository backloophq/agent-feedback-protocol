const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Time-sortable unique ID (ULID layout) with a prefix, e.g. `fb_01JAX3ZK7Q8W2M4N6P9RTV5B`. */
export function newId(prefix = "fb"): string {
  let time = Date.now();
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}_${ts}${rand}`;
}

/**
 * Pseudonymize an account ID with HMAC-SHA256, so collectors can count
 * affected customers without learning who they are.
 */
export async function hashAccount(accountId: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(accountId)));
  let hex = "";
  for (const b of sig.slice(0, 12)) hex += b.toString(16).padStart(2, "0");
  return `acct_${hex}`;
}
