# Digital Signature Attacks

## DSA (Digital Signature Algorithm)

Same structure as ECDSA but over Z_p* instead of an elliptic curve.

### Nonce Reuse

Identical to ECDSA nonce reuse (see `ecc-attacks.md`):
```python
# Two signatures (r, s1, h1) and (r, s2, h2) with same k:
k = (h1 - h2) * pow(s1 - s2, -1, q) % q
x = (s1 * k - h1) * pow(r, -1, q) % q
```

### Biased Nonce

If nonce k has known bias (e.g., generated from truncated hash,
weak RNG), use the Hidden Number Problem + lattice reduction.
See `ecc-attacks.md` for the HNP approach.

### Nonce from Timestamp

**When**: k = hash(timestamp) or k = timestamp directly.

**How**: Brute-force the timestamp range.

## Schnorr Signatures

**Scheme**: Sign: choose random k, compute R = g^k, e = H(R || M),
s = k - x*e. Verify: g^s * y^e == R.

### Nonce Reuse

```python
# Same as DSA: two sigs with same R reveal x
# s1 = k - x*e1, s2 = k - x*e2
# x = (s1 - s2) / (e2 - e1) mod q
```

### Weak Hash in Fiat-Shamir

If the hash function used for the challenge is weak (short output,
predictable), the attacker can find collisions or preimages to
forge signatures.

## Ed25519

**Scheme**: Edwards curve variant of Schnorr. Uses deterministic
nonce: k = H(secret_scalar_half || M).

### Fault Injection

**When**: Faulty computation during signing (bit flip, skip).

**How**: If a fault causes incorrect point multiplication,
the faulty signature combined with the correct one reveals
the private key via algebraic relations.

### Torsion Points

Ed25519's curve has cofactor 8. Points of small order (torsion
points) can be added to valid public keys or signatures:

```python
# Adding a torsion point T (order 8) to a valid signature component
# The verification may pass for "equivalent" keys
# Used for: key substitution attacks, malleability
```

### Clamping Bypass

Ed25519 "clamps" the scalar: clears low 3 bits, sets bit 254.
If clamping is skipped, the key may be in a small subgroup,
enabling attacks.

## BLS Signatures

**Scheme**: Pairing-based. sig = H(M)^sk on curve G1,
verify: e(sig, g2) == e(H(M), pk).

### Rogue Key Attack

**When**: Aggregating BLS signatures without proof of possession.

**How**: Attacker chooses pk_a = g2^a / pk_victim. The aggregate
public key becomes g2^a, and the attacker can sign for the
aggregate without the victim's cooperation.

**Prevention**: Require proof of possession (sign a specific message
with each key before aggregation).

### Forging with Related Messages

If the hash-to-curve function H is not a random oracle (e.g.,
simple hash without proper domain separation), related-message
attacks may apply.

## RSA Signatures

### Textbook RSA

**When**: sig = m^d mod n (no padding).

**How**: Multiplicative forgery: sig(m1*m2) = sig(m1) * sig(m2) mod n.
Blind signature forgery: get sig(r^e * m) = r * sig(m).

### PKCS#1 v1.5 Signature (Bleichenbacher '06)

**When**: Verifier checks only the prefix of the decrypted signature
(doesn't verify that the padding fills the entire block).

**How**: Construct a value whose e-th root has the correct prefix
(contains the hash with valid PKCS#1 padding) without knowing d.

```python
# For e = 3: construct a cube whose top bytes match
# 0x00 0x01 0xFF...0xFF 0x00 [DigestInfo] [hash]
# Pad the rest with garbage
# Cube root of this value is a valid "signature"
```

**Requirement**: e must be small (e=3 is classic). Larger e makes
the attack harder.

## Aggregate/Multi-Signature Attacks

### Key Cancellation

In naive multi-signature schemes (e.g., sum of public keys),
an attacker can choose their key to cancel another party's key:
pk_a = -pk_victim, so pk_agg = 0.

### Sub-Key Extraction

If the aggregation scheme leaks information about individual
signers' contributions, extract individual keys from aggregate
signatures.

## Common CTF Patterns

| Pattern | Attack |
|---|---|
| Two sigs with same r/R | Nonce reuse → key recovery |
| Many sigs with biased nonce | HNP + lattice |
| RSA sig with e=3, weak padding | Bleichenbacher '06 prefix attack |
| Textbook RSA sig | Multiplicative forgery |
| BLS without PoP | Rogue key attack |
| Ed25519 fault | Differential fault analysis |
| Schnorr with weak hash | Challenge collision → forgery |
