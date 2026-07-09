# Wavelength — Security Setup Guide

## File Structure
```
Anonymous-Chatting/
├── index.html                        ← markup only, strict CSP, no inline scripts
├── style.css                         ← all styles
├── app.js                            ← all JavaScript
└── supabase/
    └── functions/
        └── relay/
            └── index.ts              ← Edge Function: server-side rate limit + message signing
```

---

## 1. Supabase Dashboard — Required Before Going Live

### 1a. Restrict Allowed Origins
- Go to: **Project Settings → API → Allowed Origins**
- Remove `*`
- Add your exact production domain: `https://yourdomain.com`

### 1b. Enable Row Level Security on ALL tables
- Go to: **Table Editor → (each table) → RLS**
- Enable RLS — deny everything for the `anon` role by default
- This app uses zero tables (Realtime Broadcast only), but RLS must be on
  to prevent the anon key from being used to read/write any future tables

### 1c. Realtime settings
- Go to: **Realtime → Configuration**
- Set max message size to 2KB (messages are capped at 500 chars)
- Enable connection throttling if available on your plan

---

## 2. Deploy the Edge Function

### Prerequisites
```bash
npm install -g supabase
supabase login
supabase link --project-ref fjugnylvwmodnuxmveyw
```

### Deploy
```bash
supabase functions deploy relay --no-verify-jwt
```

`--no-verify-jwt` is intentional — the relay uses the anon key for auth
(users are anonymous by design). Rate limiting is enforced by IP inside the function.

### Set the service role key secret (used by the relay to broadcast)
```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

> The service role key is NEVER in client code — it lives only in the Edge Function environment.

---

## 3. Update app.js After Deployment

The `RELAY_URL` in `app.js` is auto-constructed from `SUPABASE_URL`:
```js
const RELAY_URL = `${SUPABASE_URL}/functions/v1/relay`;
```
No changes needed if your Supabase URL is correct.

---

## 4. Hosting (Vercel / Netlify / Cloudflare Pages)

Deploy the root folder (`index.html`, `style.css`, `app.js`).
The `supabase/` folder is for the Edge Function only — it does not need to be served.

### Add HTTP security headers at the hosting layer
These reinforce the meta CSP tags (hosting-layer headers take precedence):

**Vercel — `vercel.json`:**
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; connect-src https://*.supabase.co wss://*.supabase.co; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "no-referrer" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" }
      ]
    }
  ]
}
```

**Netlify — `netlify.toml`:**
```toml
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; connect-src https://*.supabase.co wss://*.supabase.co; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';"
    X-Content-Type-Options = "nosniff"
    X-Frame-Options = "DENY"
    Referrer-Policy = "no-referrer"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
    Strict-Transport-Security = "max-age=63072000; includeSubDomains; preload"
```

---

## 5. SRI Hash — How to Regenerate

If you update the supabase-js version, regenerate the hash:

**Linux/macOS:**
```bash
curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@NEW_VERSION/dist/umd/supabase.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

**Windows (PowerShell):**
```powershell
$bytes = (Invoke-WebRequest "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@NEW_VERSION/dist/umd/supabase.min.js").Content
$hash = [System.Security.Cryptography.SHA384]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($bytes))
[Convert]::ToBase64String($hash)
```

Then update the `integrity="sha384-..."` attribute in `index.html`.

---

## Security Model Summary

| Layer | Protection |
|-------|-----------|
| CSP (no unsafe-inline) | Blocks XSS script injection |
| SRI on CDN script | Blocks supply chain attacks |
| Edge Function relay | Server-side rate limit (5 msg/3s per IP), message signing, input validation |
| `_serverVerified` flag | Client ignores any message not relayed through Edge Function |
| RLS on all tables | Anon key cannot read/write any database table |
| Allowed Origins restriction | Anon key only works from your domain |
| HSTS | Forces HTTPS, prevents downgrade attacks |
| frame-ancestors none | Blocks clickjacking |
| crypto.getRandomValues | Cryptographically secure user IDs |
