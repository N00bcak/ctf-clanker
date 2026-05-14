# Hash and MAC Attacks

## Length Extension
**When**: MAC = H(key ‖ msg) with Merkle-Damgard hash (MD5, SHA-1, SHA-256). | **Not vulnerable**: HMAC, SHA-3, BLAKE.
```python
# IN: original_hash, original_data, data_to_add, key_length  OUT: new_hash, new_msg
import hashpumpy
new_hash, new_msg = hashpumpy.hashpump(original_hash, original_data, data_to_add, key_length)
# new_msg = original_data || padding || data_to_add
# Verify: server should accept (new_msg, new_hash)
```
```bash
hash_extender -d "$ORIGINAL_DATA" -s "$ORIGINAL_HASH" -a "$APPEND" -f sha256 -l "$KEY_LEN"
```
**Trap**: must know or guess key length. Try 8–32 if unknown.

## Birthday Collision (Truncated Hash)
**When**: hash is truncated or output is short (< 64 bits feasible, < 80 bits borderline).
```python
# IN: hash_func, target_bits  OUT: m1, m2 with hash_func(m1)[:k] == hash_func(m2)[:k]
import hashlib
seen = {}
for i in range(2**40):
    h = hashlib.sha256(str(i).encode()).hexdigest()[:target_bits//4]
    if h in seen:
        m1, m2 = seen[h], i
        assert hashlib.sha256(str(m1).encode()).hexdigest()[:target_bits//4] == h
        break
    seen[h] = i
```

## MD5 Chosen-Prefix Collision
```bash
# IN: prefix.bin  OUT: out1.bin, out2.bin with identical MD5
fastcoll -p prefix.bin -o out1.bin out2.bin
md5sum out1.bin out2.bin  # verify identical hashes
```

## HMAC Timing Oracle
**When**: comparison is byte-by-byte (not constant-time). | **Trap**: need many samples per byte; use median, not mean.
```python
# IN: url, mac_param_name  OUT: valid_mac (bytes)
import time, requests
known = b""
for pos in range(32):
    best, best_t = 0, 0
    for b in range(256):
        mac = known + bytes([b]) + b"\x00"*(31-pos)
        times = []
        for _ in range(100):
            t0 = time.perf_counter()
            requests.get(url, params={mac_param_name: mac.hex()})
            times.append(time.perf_counter() - t0)
        med = sorted(times)[50]
        if med > best_t: best, best_t = b, med
    known += bytes([best])
# Verify: final request with known should return 200
assert requests.get(url, params={mac_param_name: known.hex()}).status_code == 200
```

## Password Hash Cracking
```bash
# hashcat — IN: hashes.txt, wordlist.txt  OUT: cracked passwords
hashcat -m 0 hashes.txt wordlist.txt       # MD5
hashcat -m 1400 hashes.txt wordlist.txt    # SHA-256
hashcat -m 3200 hashes.txt wordlist.txt    # bcrypt
hashcat -m 1800 hashes.txt wordlist.txt    # sha512crypt
# John: john --wordlist=wordlist.txt hashes.txt
# Online: crackstation.net
```

## Custom MAC Weaknesses
| Construction | Vulnerability |
|---|---|
| XOR of encrypted blocks | XOR known MAC with block diff to forge |
| CBC-MAC without length prefix | Length extension (see `block-cipher-modes.md`) |
| Polynomial MAC (GCM-style) + nonce reuse | Auth key recovery via GF(2^128) GCD |
