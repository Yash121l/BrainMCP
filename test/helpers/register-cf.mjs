// node --import this file: resolves "cloudflare:workers" to a local stand-in.
import { register } from 'node:module';

register(new URL('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: ${JSON.stringify(new URL('./cloudflare-workers.mjs', import.meta.url).href)}, shortCircuit: true };
  return next(specifier, context);
}`)));
