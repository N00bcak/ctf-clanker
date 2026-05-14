# Diffie-Hellman

## Small Subgroup Attack
**When**: p−1 has small prime factors and no subgroup validation.
```python
# SageMath — IN: p, g, oracle(A)->g^(x*A) mod p  OUT: x
small_primes = [f for f, e in factor(p - 1) if f < 10000]
residues, mods = [], []
for q in small_primes:
    h = pow(int(g), (p-1)//q, p)       # generator of order q
    resp = oracle(h)                     # server computes h^x mod p
    for xi in range(q):                  # brute-force x mod q
        if pow(h, xi, p) == resp:
            residues.append(xi); mods.append(q); break
x = CRT(residues, mods)
assert pow(int(g), int(x), p) == pow(int(g), int(x) % (p-1), p)
```

## Pohlig-Hellman
**When**: group order is smooth (all small prime factors).
```python
# SageMath — IN: p, g, h (h = g^x mod p)  OUT: x
g_f = GF(p)(g); h_f = GF(p)(h); order = p - 1
parts, mods = [], []
for q, e in factor(order):
    gi = g_f^(order // q^e); hi = h_f^(order // q^e)
    parts.append(discrete_log(hi, gi, ord=q^e))
    mods.append(q^e)
x = CRT(parts, mods)
assert g_f^x == h_f
```

## Discrete Log (small prime)
**When**: prime is < ~1024 bits or built-in solver is fast enough.
```python
# SageMath — IN: p, g, h  OUT: x
x = discrete_log(GF(p)(h), GF(p)(g))
assert GF(p)(g)^x == GF(p)(h)
```

## Man-in-the-Middle
**When**: no authentication on the DH exchange.
Intercept A = g^a, B = g^b. Send g^m to both. Establish separate shared secrets g^(am) and g^(bm). Relay decrypted/re-encrypted traffic.

## Static DH Oracle
**When**: server returns g^(x·a) for attacker-chosen a. Combine with small subgroup → CRT to recover x.

## DLP in GF(p^k)
**When**: DH in extension field with small p — DLP may be quasi-polynomial. | **Trap**: ensure you're working in the right field representation.
```python
# SageMath — IN: p, k, g, h  OUT: x
F.<a> = GF(p^k); x = h.log(g); assert g^x == h
```

## ElGamal Encryption Attacks
**When**: ElGamal encryption (c1 = g^k mod p, c2 = m · y^k mod p).

### Nonce Reuse
**When**: Two messages encrypted with the same nonce k → same c1 value.
```python
# IN: p, c1, c2_a, c2_b, m_a (known plaintext)  OUT: m_b
# c2_a = m_a · y^k,  c2_b = m_b · y^k
# → m_b = m_a · c2_b · pow(c2_a, -1, p) mod p
m_b = (m_a * c2_b * pow(c2_a, -1, p)) % p
assert True  # verify by checking decryption
```

### Multiplicative Homomorphism
```python
# ElGamal is multiplicatively homomorphic:
# Enc(m1) * Enc(m2) = Enc(m1 * m2)
# (c1_a * c1_b, c2_a * c2_b) decrypts to (m_a * m_b) mod p
# Use for: chosen-ciphertext attack, malleability exploitation
```

## Rabin Cryptosystem
**When**: Encryption is c = m² mod n. Decryption requires factoring n.
```python
# IN: c, p, q (factors of n)  OUT: m (one of 4 candidates)
# Compute square roots mod p and mod q, combine via CRT
from sympy.ntheory.residues import sqrt_mod
r_p = sqrt_mod(c, p)      # ±r mod p
r_q = sqrt_mod(c, q)      # ±r mod q
# CRT gives 4 candidates: (±r_p, ±r_q)
from sympy.ntheory.modular import crt
candidates = []
for rp in [r_p, p - r_p]:
    for rq in [r_q, q - r_q]:
        m, _ = crt([p, q], [rp, rq])
        candidates.append(m)
# The correct plaintext is the one that makes semantic sense (printable, has flag format)
for m in candidates:
    try:
        pt = long_to_bytes(m)
        if pt.isascii(): print(pt)
    except: pass
```
**Trap**: Always 4 candidate plaintexts. The challenge usually provides a way to disambiguate (padding, flag format, or additional constraints).

## ECDH
See `ecc-attacks.md`. No small subgroup attack if curve order is prime; use invalid curve attack instead.
