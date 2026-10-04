const enc = new TextEncoder();
const dec = new TextDecoder();

export const KEK_VERSION = 1;

const toB64 = (bytes) => {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const hasKek = (env) => typeof env.BRAIN_KEK === 'string' && fromB64Safe(env.BRAIN_KEK)?.length === 32;
function fromB64Safe(s) {
  try { return fromB64(s); } catch { return null; }
}

const aesKey = (raw, usages) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);

async function seal(raw, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(raw, ['encrypt']), plain);
  return `${toB64(iv)}.${toB64(ct)}`;
}

async function open(raw, sealed) {
  const [iv, ct] = String(sealed).split('.');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(raw, ['decrypt']), fromB64(ct));
}

function kek(env) {
  if (!hasKek(env)) throw new Error('BRAIN_KEK is not configured; hosted spaces need it');
  return fromB64(env.BRAIN_KEK);
}

export async function newDataKey(env) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { dek: toB64(raw), wrapped: await seal(kek(env), raw) };
}

export async function unwrapDataKey(env, wrapped) {
  if (!wrapped) throw new Error('this space has no data key');
  return toB64(await open(kek(env), wrapped));
}

export const encryptText = async (dekB64, text) => seal(fromB64(dekB64), enc.encode(text));
export const decryptText = async (dekB64, sealed) => dec.decode(await open(fromB64(dekB64), sealed));

export const encryptWithKek = async (env, text) => seal(kek(env), enc.encode(text));
