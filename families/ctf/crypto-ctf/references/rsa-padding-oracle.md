# RSA Padding Oracle Attacks

Attacks exploiting error messages or behavioral differences during
RSA decryption to recover plaintext.

## Bleichenbacher's Attack (PKCS#1 v1.5)

**When**: RSA with PKCS#1 v1.5 padding and a padding oracle —
the server reveals whether decrypted ciphertext has valid padding.

**How**: PKCS#1 v1.5 requires the decrypted message to start with
`\x00\x02`. By multiplying the ciphertext by s^e mod n (RSA's
multiplicative homomorphism), the attacker creates modified ciphertexts
and queries the oracle to narrow down the plaintext range.

**Algorithm**:
1. Find s such that c * s^e mod n decrypts to valid padding.
2. Each valid s narrows the set of intervals where m can lie.
3. Iterate: find more s values, shrink intervals, until m is unique.

```python
# Pseudocode for Bleichenbacher
# Oracle: oracle(c) returns True if decrypt(c) has valid PKCS padding

B = 2^(8 * (key_bytes - 2))  # 2B = lower bound of valid padding

def bleichenbacher(c, e, n, oracle):
    # Phase 1: find initial s1
    s = n // (3 * B)
    while not oracle(c * pow(s, e, n) % n):
        s += 1

    intervals = [(2*B, 3*B - 1)]

    while len(intervals) > 1 or intervals[0][1] - intervals[0][0] > 0:
        # Phase 2: narrow intervals using new s values
        # Phase 3: when single interval, compute s from range
        ...  # standard Bleichenbacher iteration

    return intervals[0][0]  # recovered plaintext
```

**Query count**: Typically ~10,000-15,000 oracle queries for a
2048-bit key. Some optimizations (Bardou et al.) reduce this.

**Gotchas**:
- The oracle may be a timing difference, not an explicit error.
- Some implementations have partial oracles (only check first byte).
- ROBOT attack (Return Of Bleichenbacher's Oracle Threat) targets
  modern TLS implementations with subtle timing oracles.

## Manger's Attack (RSA-OAEP)

**When**: RSA with OAEP padding and an oracle that distinguishes
whether the decrypted value is less than B = 2^(8*(k-1)) where
k is the key length in bytes.

**How**: The oracle effectively answers "is the decrypted value
in [0, B) or [B, n)?" This single bit of information per query
is enough to binary-search for the plaintext.

**Algorithm**:
1. Find f1 such that floor(c * f1^e / n) has a specific property.
2. Binary search using multiplicative blinding to narrow the range.
3. Converges in ~1000-1500 queries for 2048-bit key.

```python
# Simplified Manger
# Oracle: oracle(c) returns True if decrypt(c) < B

B = 2^(8 * (key_bytes - 1))

# Step 1: find f1 such that f1*m is in [B, 2B)
f1 = 2
while oracle(c * pow(f1, e, n) % n):
    f1 *= 2

# Step 2: find f2 such that f2*m is in [n, n+B)
f2 = (n + B) // B * (f1 // 2)
# ... narrow with binary search
```

**Advantage over Bleichenbacher**: Fewer queries (~1000 vs ~10000)
and simpler implementation.

## LSB Oracle

**When**: An oracle reveals the least significant bit of the
decrypted plaintext.

**How**: Multiply ciphertext by 2^e mod n. If the oracle says
the LSB of decrypt(c * 2^e) is 0, then 2*m mod n is even,
meaning m < n/2. Binary search on m.

```python
# LSB Oracle attack
lower, upper = 0, n
for i in range(n.bit_length()):
    c = c * pow(2, e, n) % n
    if oracle_lsb(c) == 0:
        upper = (lower + upper) // 2
    else:
        lower = (lower + upper) // 2

m = upper  # recovered plaintext
```

**Queries needed**: Exactly log2(n) ≈ 2048 for a 2048-bit key.

## Parity Oracle

Similar to LSB oracle. Any oracle that leaks a single bit of
information about the plaintext per query enables binary search
via RSA's multiplicative homomorphism.

## Timing Oracle

**When**: Decryption time varies based on padding validity or
plaintext properties.

**How**: Measure response times to distinguish valid from invalid
padding. Requires many measurements to overcome noise.

**Practical**: Use statistical methods (t-test, percentile comparison)
with ~100-1000 measurements per test. Noisier than explicit oracles
but increasingly common in CTF challenges.
