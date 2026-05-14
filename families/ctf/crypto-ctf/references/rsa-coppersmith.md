# RSA Coppersmith Method

Finding small roots of polynomials modulo n or its factors.
Coppersmith's theorem is the Swiss army knife of RSA attacks.

## Core Theorem

Given f(x) of degree d modulo n, if a root x_0 satisfies
|x_0| < n^(1/d), it can be found in polynomial time using
LLL lattice reduction.

For roots modulo a factor p of n (unknown), if |x_0| < n^(beta^2/d)
where p > n^beta, the root can be found.

## Partial Key Recovery (Known High Bits of p)

**When**: Some bits of p are known (e.g., from a side channel,
partial leak, or structured prime generation).

```python
# SageMath — known high bits of p
n = ...
p_high = ...  # known high bits (e.g., top 512 of 1024)
unknown_bits = 512

P.<x> = PolynomialRing(Zmod(n))
f = p_high + x
roots = f.small_roots(X=2^unknown_bits, beta=0.5)
if roots:
    p = p_high + int(roots[0])
    q = n // p
    assert p * q == n
```

**Key parameter**: `beta` — fraction of n's bits that p represents.
For balanced RSA (p ≈ q ≈ sqrt(n)), use beta=0.5.

## Known High Bits of d

**When**: Some bits of the private exponent d are known.

```python
# SageMath — known high bits of d
# d ≡ e^(-1) mod (p-1)(q-1)
# If d_high is known and d = d_high + x:
# e * (d_high + x) ≡ 1 + k*(n - p - q + 1) for some k
# Rearrange and solve for x using small_roots
```

## Stereotyped Message (Known Plaintext Portion)

See `rsa-small-exponent.md` for the small-e variant. Coppersmith
also applies when e is not small but the unknown portion of the
message is small enough.

**Bound**: Unknown portion must be < n^(1/e) bits.

## Related Messages (Franklin-Reiter + Coppersmith)

See `rsa-small-exponent.md` for Franklin-Reiter. When the
relationship between messages involves an unknown parameter,
Coppersmith can first recover that parameter.

## Bivariate Coppersmith

**When**: Two unknowns in a polynomial equation over Z/nZ.

Bivariate Coppersmith is heuristic (not proven polynomial time)
but works well in practice for CTF-sized parameters.

```python
# SageMath — bivariate (Herrmann-May / Boneh-Durfee style)
# Use existing implementations:
# - https://github.com/mimoo/RSA-and-LLL-attacks
# - https://github.com/defund/coppersmith
```

## Practical Tips

1. **Start with `small_roots()`**: SageMath's built-in method handles
   most CTF cases. Adjust `X` (bound), `beta`, and `epsilon`.

2. **epsilon parameter**: Controls lattice quality. Smaller epsilon =
   larger lattice = slower but more likely to work. Default 1/8 is
   usually fine; try 0.05 or 0.02 if default fails.

3. **Debugging**: If `small_roots()` returns empty:
   - Check that X is not too large (must be < n^(beta^2/d))
   - Try increasing epsilon (larger lattice)
   - Verify the polynomial is correct (modular arithmetic errors)
   - Check that the root actually exists in the expected range

4. **Multiple roots**: `small_roots()` can return multiple roots.
   Test each one.

## Common CTF Patterns

| Pattern | Polynomial |
|---|---|
| Known high bits of p | f(x) = p_high + x mod n |
| Known plaintext prefix (small e) | f(x) = (prefix + x)^e - c mod n |
| LSB oracle | Combine oracle queries to recover bits |
| Partial d exposure | e*(d_high + x) - 1 ≡ 0 mod (some factor) |
| Close primes with offset | f(x) = (p_0 + x) * (p_0 + x + delta) - n |
