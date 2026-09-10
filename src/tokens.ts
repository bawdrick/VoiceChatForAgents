// Token generation and comparison. Tokens are never stored anywhere in their raw
// form: the Durable Object keeps SHA-256 hashes and compares against those.

const TOKEN_BYTES = 16; // 128 bits, the minimum the design calls for
const LONG_TOKEN_BYTES = 32;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Short-lived, travels in the QR code, so keep it compact. */
export function newPairToken(): string {
  return randomToken(TOKEN_BYTES);
}

/** Lives as long as the session and never leaves the user's machine. */
export function newAgentToken(): string {
  return randomToken(LONG_TOKEN_BYTES);
}

/** Replaces the pair token once the phone has loaded the page. */
export function newCookieToken(): string {
  return randomToken(LONG_TOKEN_BYTES);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

/**
 * The Durable Object name is derived from the pair token, so the Worker can find
 * the session without any lookup table. One-way, so the resulting id is safe to
 * hand to the browser as a plain address; the credentials are the cookie and the
 * agent token, never the id.
 */
export async function sessionIdFromPairToken(pairToken: string): Promise<string> {
  return sha256(pairToken);
}

/** Comparison that does not return early on the first differing character. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Loose sanity check before a token is used as part of a URL or a DO name. */
export function looksLikeToken(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}
