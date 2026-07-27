---
name: web-ctf
description: Exploit injection, authentication, client-side, deserialization, or SSRF flaws in CTF web applications.
---

# Web CTF

## Purpose

Analyze and exploit web application vulnerabilities in CTF settings. Covers
reconnaissance, server-side injection, client-side attacks, authentication
bypass, and application logic flaws.

## Use When

- The challenge involves an HTTP service, web application, API, or SPA.
- The attack surface is browser-facing: forms, cookies, headers, parameters.
- Authentication, session management, or access control is the target.
- Client-side vulnerabilities (XSS, CSRF, DOM manipulation) are involved.

## Do Not Use

- The primary artifact is a binary — use `reverse-ctf` or `pwn-ctf`.
- The challenge is purely cryptographic — use `crypto-ctf`.
- The web app is only a delivery mechanism for a forensic artifact — use
  `forensics-ctf`.
- The category is unknown — use `ctf-triage` first.
- Do not spawn, request, or rely on subagents.

## Needs

- Target URL or service endpoint.
- Challenge source code if provided.
- Authentication credentials or session state if given.
- Flag format or success condition.

## Returns

- Attack surface map with identified entry points.
- Vulnerability identification with proof of concept.
- Exploit that retrieves the flag, or explicit blocker with evidence.
- Request/response evidence supporting findings.

## Done Conditions

- The vulnerability is identified and exploited to retrieve the flag.
- If blocked, the attack surface is mapped, tested techniques are listed,
  and the specific barrier is documented.
- All tested injection points and results are recorded.

## Persistence And Yield

Useful progress means new endpoint discovered, injection point confirmed,
authentication mechanism understood, filter bypass found, or partial data
exfiltrated.

Before yielding:

- Complete the initial reconnaissance pass (routes, technology, source review).
- Try the primary attack vector identified during recon.
- Try one distinct bounded alternative (different injection type, different
  parameter, different bypass technique).
- Check whether missing information is discoverable (source disclosure,
  error messages, header leaks).
- Confirm the next action would repeat prior work, require unsafe guessing,
  or leave this skill's boundary.

Do not yield merely because common injections failed. Enumerate the full
attack surface before concluding.

When yielding, return the reconnaissance performed, injection points tested,
specific blocker, why more work would repeat, and the next recovery step.

## Methodology

### Evidence-First Workflow

Start from the real application. Inspect actual requests and responses
before hypothesizing vulnerability classes.

```
curl -v <url>                           # response headers, status, redirects
curl -s <url>/robots.txt                # disallowed paths
curl -s <url>/sitemap.xml               # site structure
curl -s <url> | grep -oE 'href="[^"]+"'  # link extraction
```

If source code is provided, read it before probing. The code is ground truth;
the running application may have additional configuration.

### Step 1: Reconnaissance

1. **Technology identification**: server header, framework fingerprints,
   error page signatures, cookie names.
2. **Route discovery**: enumerate endpoints from source, HTML links,
   JavaScript, and directory brute-force.
3. **Source review**: look for input handling, database queries, template
   rendering, deserialization, file operations.
4. **Authentication state**: how are sessions managed? JWT? Cookies? Tokens?

### Step 2: Server-Side Testing

Test in order of likelihood and cost:

1. **SQL injection**: `' OR 1=1 --` in login, search, and parameter fields.
   Check for error-based, blind boolean, and time-based variants.
2. **SSTI**: `{{7*7}}`, `${7*7}`, `<%= 7*7 %>` in user-controlled template
   inputs.
3. **Command injection**: `; id`, `| id`, `$(id)` in parameters processed
   by shell commands.
4. **SSRF**: URL parameters (`url=`, `page=`, `img=`) with internal addresses.
5. **Path traversal / LFI**: `../../etc/passwd` in file path parameters.
   PHP-specific: `php://filter/convert.base64-encode/resource=`.
6. **Deserialization**: inspect cookies, hidden fields, and API bodies for
   serialized objects (PHP `O:`, Java base64, Python pickle).

### Step 3: Client-Side Testing

1. **Reflected XSS**: inject `<script>alert(1)</script>` or event handlers
   in reflected parameters.
2. **Stored XSS**: inject payloads in persistent fields (comments, profiles).
3. **DOM XSS**: trace client-side JavaScript that writes user input to DOM.
4. **CSRF**: test state-changing requests without CSRF tokens.

### Step 4: Authentication and Authorization

1. **JWT attacks**: decode payload, try `alg:none`, RS256→HS256 confusion,
   `kid` injection, `jwk`/`jku` header injection.
2. **Session management**: predictable session IDs, session fixation,
   insecure cookie flags.
3. **Access control**: IDOR (change object IDs), forced browsing (access
   admin endpoints), HTTP verb tampering.
4. **OAuth/SAML**: redirect manipulation, state parameter bypass,
   token substitution.

### Step 5: Application Logic

1. **Race conditions**: concurrent requests to exploit TOCTOU.
2. **Business logic**: price manipulation, coupon reuse, negative quantities.
3. **Prototype pollution** (Node.js): `__proto__`, `constructor.prototype`
   in JSON bodies.
4. **File upload**: extension bypass, MIME type bypass, path traversal in
   filename.

### Targeted Web Search

When encountering an unfamiliar framework, filter, or WAF:

1. Search for the exact framework name + version + known CVEs.
2. Search for the specific filter pattern + bypass techniques.
3. Prefer official documentation and security advisories over writeups.
4. Re-ground every bypass against the real application behavior.

## Pivot Rules

- If the web app's authentication involves a cryptographic weakness (JWT
  crypto, custom MAC), the crypto analysis belongs to `crypto-ctf`.
- If the web app serves a binary or WASM module that needs reversing,
  hand off to `reverse-ctf`.
- If the web app delivers forensic artifacts (file downloads, captured
  traffic), hand off to `forensics-ctf`.
- If the challenge is a web-based sandbox escape (pyjail via web interface),
  the jail escape logic belongs to `misc-ctf`.

## Reference

- `references/reconnaissance.md` — fingerprinting, directory enumeration, source review
- `references/sql-injection.md` — union, blind, error-based, NoSQL, sqlmap
- `references/ssti.md` — Jinja2, Twig, Freemarker, ERB, EJS, Pug
- `references/command-injection.md` — separators, blind, filter bypass
- `references/ssrf.md` — internal targets, cloud metadata, DNS rebinding, gopher
- `references/path-traversal-lfi.md` — LFI, PHP wrappers, log poisoning, zip symlink
- `references/xss.md` — reflected, stored, DOM, CSP bypass, DOM clobbering
- `references/jwt-attacks.md` — alg confusion, none, kid injection, jwk/jku
- `references/deserialization.md` — PHP, Java, Python pickle, .NET, React RSC
- `references/auth-and-access.md` — IDOR, OAuth, SAML, session, race conditions
- `references/prototype-pollution.md` — Node.js pollution, VM escape, RCE gadgets
- `references/xxe.md` — XML External Entity injection, blind XXE, OOB
- `references/request-smuggling.md` — HTTP desync, CL.TE, TE.CL, H2 downgrade
- `references/graphql.md` — introspection, injection, batching, authorization bypass
- `references/file-upload.md` — extension bypass, polyglot files, webshell, race condition
- `references/cors-and-headers.md` — CORS misconfig, CRLF injection, cache poisoning
- `references/web3-smart-contracts.md` — Solidity, reentrancy, EVM, flash loans
- `references/php-type-juggling.md` — loose comparison, magic hashes, strcmp bypass, JSON type confusion
- `references/php-disable-functions.md` — LD_PRELOAD+mail, FFI, Imagick, imap_open bypass
- `references/ldap-xpath-injection.md` — LDAP filter injection, XPath injection, blind extraction
