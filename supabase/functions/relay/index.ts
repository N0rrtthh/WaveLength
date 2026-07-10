const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ipWindows = new Map<string, number[]>();
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const times = (ipWindows.get(ip) ?? []).filter(t => now - t < 3000);
  if (times.length >= 5) { ipWindows.set(ip, times); return true; }
  times.push(now);
  ipWindows.set(ip, times);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of ipWindows) {
    if (times.every(t => now - t > 3000)) ipWindows.delete(ip);
  }
}, 60_000);

const ALLOWED_TYPES = new Set([
  'msg', 'typing', 'join', 'leave',
  'looking', 'claim', 'claim-ack', 'claimed', 'heartbeat', 'react',
]);
const ALLOWED_EMOJIS = new Set(['❤️', '😂', '👍', '🔥', '😮', '😢', '🎉']);
const CHANNEL_RE = /^[a-z0-9_-]{1,64}$/;
const HEX_RE = /^[a-f0-9]{1,64}$/;
const MID_RE = /^[a-f0-9]{1,32}$/;
const MAX_TEXT = 500;
const MAX_NAME = 24;

function sanitizeName(s: unknown): string {
  if (typeof s !== 'string') return 'Unknown';
  return s.replace(/[<>"'`]/g, '').trim().slice(0, MAX_NAME) || 'Unknown';
}

function hex(s: unknown, max = 64): string {
  return typeof s === 'string' && HEX_RE.test(s) ? s.slice(0, max) : '';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return new Response('Bad Request', { status: 400 }); }

  const { channel, payload } = body as { channel?: unknown; payload?: Record<string, unknown> };

  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel))
    return new Response('Invalid channel', { status: 400 });
  if (!payload || typeof payload !== 'object')
    return new Response('Invalid payload', { status: 400 });

  const type = payload.type;
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type))
    return new Response('Invalid type', { status: 400 });

  let safeText = '';
  if (type === 'msg') {
    if (isRateLimited(ip)) return new Response('Rate limited', { status: 429 });
    if (typeof payload.text !== 'string' || payload.text.length > MAX_TEXT)
      return new Response('Message too long', { status: 400 });
    safeText = payload.text.replace(/\0/g, '').trim();
    if (!safeText) return new Response('Empty message', { status: 400 });
  }

  if (type === 'react') {
    if (typeof payload.mid !== 'string' || !MID_RE.test(payload.mid))
      return new Response('Invalid mid', { status: 400 });
    if (typeof payload.emoji !== 'string' || !ALLOWED_EMOJIS.has(payload.emoji))
      return new Response('Invalid emoji', { status: 400 });
  }

  const safePayload: Record<string, unknown> = { type, _serverVerified: true };
  const from = hex(payload.from);
  if (from) safePayload.from = from;
  const to = hex(payload.to);
  if (to) safePayload.to = to;
  if (typeof payload.id === 'string' && HEX_RE.test(payload.id)) safePayload.id = payload.id;
  if (typeof payload.room === 'string' && CHANNEL_RE.test(payload.room)) safePayload.room = payload.room;
  if (type === 'msg') safePayload.text = safeText;
  if (payload.fromName !== undefined) safePayload.fromName = sanitizeName(payload.fromName);
  if (type === 'typing') safePayload.state = payload.state === true;
  if (type === 'react') {
    safePayload.mid = payload.mid;
    safePayload.emoji = payload.emoji;
    safePayload.add = payload.add === true;
  }

  // Use REST broadcast API — no WebSocket handshake, instant delivery
  const broadcastRes = await fetch(
    `${SUPABASE_URL}/realtime/v1/api/broadcast`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{
          topic: channel,
          event: 'data',
          payload: safePayload,
        }],
      }),
    }
  );

  if (!broadcastRes.ok) return new Response('Relay error', { status: 502 });
  return new Response('OK', { status: 200 });
});
