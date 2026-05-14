# Secret Sharing

## Shamir — Lagrange Recovery
**When**: t shares of a (t−1)-degree polynomial over Z_p.
```python
# SageMath — IN: shares [(x_i, y_i)], p  OUT: secret (constant term)
F = GF(p)
shares_f = [(F(x), F(y)) for x, y in shares]
secret = sum(
    y * prod((F(0)-xj)/(xi-xj) for j,(xj,_) in enumerate(shares_f) if j!=i)
    for i,(xi,y) in enumerate(shares_f)
)
# Verify: reconstruct full polynomial and check all shares
R.<X> = PolynomialRing(F)
poly = R.lagrange_polynomial(shares_f)
assert poly(0) == secret
for x, y in shares_f: assert poly(x) == y
```

## Insufficient Randomness
**When**: coefficients derived from weak PRNG or deterministic function → fewer than t shares may suffice.
```python
# IN: shares, p, coefficient_generator(seed)  OUT: secret
# Brute-force seed space
for seed in range(2**32):
    coeffs = coefficient_generator(seed)
    R.<X> = PolynomialRing(GF(p))
    poly = sum(c * X^i for i, c in enumerate(coeffs))
    if all(poly(F(x)) == F(y) for x, y in shares):
        print(f"Seed: {seed}, Secret: {poly(0)}")
        break
```

## Partial Share Leakage
**When**: MSBs or share mod small number leaked. | Crosses into Coppersmith/lattice territory — see `lattice-attacks.md`.

## Additive Secret Sharing
s = s₁ + s₂ + … + sₙ mod p. One missing share hides everything (info-theoretic). If shares reused across secrets: linear algebra.

## CRT-Based (Asmuth-Bloom)
```python
# IN: shares [(x_i, m_i)], moduli must be pairwise coprime  OUT: secret mod M
from sympy.ntheory.modular import crt
remainders = [s for s, _ in shares]
moduli = [m for _, m in shares]
secret, M = crt(moduli, remainders)
for s, m in shares: assert secret % m == s
```

## Threshold Signatures (FROST)
**Trap**: rogue key attack if no proof-of-possession; nonce manipulation if commitments aren't binding. See `digital-signatures.md`.

## Common Patterns
| Scenario | Approach |
|---|---|
| t shares given | Lagrange interpolation |
| t−1 shares + side info | Exploit the side channel |
| Weak coefficients | Brute-force seed |
| Small field | Brute-force missing share |
| Shares reused across sessions | Linear algebra over shared structure |
