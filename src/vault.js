// Credential vault for upstream accounts. VAULT_KEK (a Worker secret, separate from
// BRAIN_KEK) wraps one random data key per connection; the data key seals that
// connection's credential. Both layers bind the connection id as AES-GCM additional
// data, so a ciphertext copied onto another connection's row fails to open.
// Nothing outside invokeUpstream (gateway.js) ever reads the plaintext.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const VAULT_KEK_VERSION = 1;

const toB64 = (bytes) => {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function kekBytes(env) {
  try {
    const raw = typeof env.VAULT_KEK === 'string' ? fromB64(env.VAULT_KEK) : null;
    return raw?.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

export const hasVaultKek = (env) => !!kekBytes(env);

const aes = (raw, usages) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);

async function seal(raw, plain, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aes(raw, ['encrypt']), plain);
  return `${toB64(iv)}.${toB64(ct)}`;
}

async function open(raw, sealed, aad) {
  const [iv, ct] = String(sealed).split('.');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(aad) }, await aes(raw, ['decrypt']), fromB64(ct)));
}

const dekAad = (connectionId, version) => `brainmcp-vault-dek|${connectionId}|v${version}`;
const dataAad = (connectionId) => `brainmcp-vault-credential|${connectionId}`;

function requireKek(env) {
  const kek = kekBytes(env);
  if (!kek) throw new Error('VAULT_KEK is not configured; set it with `wrangler secret put VAULT_KEK` (32 random bytes, base64)');
  return kek;
}

/** Encrypt a credential object for one connection and store it, replacing any previous one. */
export async function storeCredential(env, connectionId, credential) {
  const kek = requireKek(env);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await seal(kek, dek, dekAad(connectionId, VAULT_KEK_VERSION));
  const sealed = await seal(dek, enc.encode(JSON.stringify(credential)), dataAad(connectionId));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO credentials (connection_id, kek_version, wrapped_dek, sealed, updated) VALUES (?, ?, ?, ?, datetime('now'))"
  ).bind(connectionId, VAULT_KEK_VERSION, wrapped, sealed).run();
}

/** The decrypted credential object for a connection, or null if it has none. */
export async function loadCredential(env, connectionId) {
  const row = await env.DB.prepare('SELECT * FROM credentials WHERE connection_id = ?').bind(connectionId).first();
  if (!row) return null;
  const kek = requireKek(env);
  const dek = await open(kek, row.wrapped_dek, dekAad(connectionId, row.kek_version));
  return JSON.parse(dec.decode(await open(dek, row.sealed, dataAad(connectionId))));
}

/** Destroy a connection's credential. Deleting the wrapped key is enough to make old copies unreadable. */
export async function deleteCredential(env, connectionId) {
  await env.DB.prepare('DELETE FROM credentials WHERE connection_id = ?').bind(connectionId).run();
}

/** Seal short arbitrary text (approval argument previews) under the vault key. */
export async function sealNote(env, text, aad) {
  return seal(requireKek(env), enc.encode(String(text)), `brainmcp-vault-note|${aad}`);
}

export async function openNote(env, sealed, aad) {
  return dec.decode(await open(requireKek(env), sealed, `brainmcp-vault-note|${aad}`));
}
