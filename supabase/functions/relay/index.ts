import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Server-side rate limit: 5 messages per 3 seconds per IP
const ipWindows = new Map<string, number[]>();
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const times = (ipWindows.get(ip) ?? []).filter(t => now - t < 3000);
  if (times.length >= 5) { ipWindows.set(ip, times); return true; }
  times.push(now);
  ipWindows.set(ip, times);
  return false;
}

// Evict stale IP entries every 60s to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of ipWindows) {
    if (times.every(t => now - t > 3000)) ipWindows.delete(ip);
  }
}, 60_000);

const ALLOWED_TYPES = new Set(['msg', 'typing', 'join', 'leave', 'looking', 'pair', 'pair-ack']);
const CHANNEL_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_TEXT = 500;
const MAX_NAME = 24;

function sanitizeName(s: unknown): string {
  if (typeof s !== 'string') return 'Unknown';
  return s.replace(/[<>"'`]/g, '').trim().slice(0, MAX_NAME) || 'Unknown';
}

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return new Response('Bad Request', { status: 400 }); }

  const { channel, payload } = body as { channel?: unknown; payload?: Record<string, unknown> };

  // Validate channel name
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel))
    return new Response('Invalid channel', { status: 400 });

  // Validate payload shape
  if (!payload || typeof payload !== 'object')
    return new Response('Invalid payload', { status: 400 });

  const type = payload.type;
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type))
    return new Response('Invalid type', { status: 400 });

  // Rate limit on msg type only (typing/join/leave are lower risk)
  let safeText = '';
  if (type === 'msg') {
    if (isRateLimited(ip)) return new Response('Rate limited', { status: 429 });
    if (typeof payload.text !== 'string' || payload.text.length > MAX_TEXT)
      return new Response('Message too long', { status: 400 });
    safeText = payload.text.replace(/\0/g, '').trim();
    if (!safeText) return new Response('Empty message', { status: 400 });
  }

  // Build a clean output object from validated/sanitized fields only.
  // All values are derived from explicit local variables, never from raw payload.
  const safePayload: Record<string, unknown> = {
    type,
    _serverVerified: true,
  };
  if (typeof payload.from === 'string')     safePayload.from     = payload.from.slice(0, 64).replace(/[^a-f0-9]/g, '');
  if (typeof payload.to === 'string')       safePayload.to       = payload.to.slice(0, 64).replace(/[^a-f0-9]/g, '');
  if (typeof payload.id === 'string')       safePayload.id       = payload.id.slice(0, 64).replace(/[^a-f0-9]/g, '');
  if (typeof payload.room === 'string' && CHANNEL_RE.test(payload.room)) safePayload.room = payload.room;
  if (type === 'msg')                       safePayload.text     = safeText;
  if (payload.fromName !== undefined)       safePayload.fromName = sanitizeName(payload.fromName);
  if (type === 'typing')                    safePayload.state    = payload.state === true;

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error } = await sb.channel(channel).send({
    type: 'broadcast',
    event: 'data',
    payload: safePayload,
  });

  if (error) return new Response('Relay error', { status: 502 });
  return new Response('OK', { status: 200 });
});
