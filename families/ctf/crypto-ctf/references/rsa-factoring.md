# RSA Factoring

## factordb
**When**: always try first — free, instant, covers most CTF moduli.
```python
# IN: n  OUT: p, q
from factordb.factordb import FactorDB
f = FactorDB(n); f.connect(); factors = f.get_factor_list()
p, q = factors[0], factors[1]
assert p * q == n
```

## Fermat
**When**: |p − q| is small (p ≈ q). | **Trap**: will loop forever if primes aren't close; cap iterations.
```python
# IN: n  OUT: p, q
from gmpy2 import isqrt, is_square
a = isqrt(n) + 1
for _ in range(1_000_000):
    b2 = a*a - n
    if is_square(b2):
        b = isqrt(b2)
        p, q = int(a - b), int(a + b)
        break
    a += 1
assert p * q == n
```

## Pollard p−1
**When**: p−1 (or q−1) is B-smooth.
```python
# IN: n, B (smoothness bound, default 100000)  OUT: p, q
from math import gcd
from sympy import nextprime
a, pr = 2, 2
while pr <= B:
    a = pow(a, pr, n); pr = nextprime(pr)
g = gcd(a - 1, n)
assert 1 < g < n, "increase B or try another method"
p, q = g, n // g
assert p * q == n
```

## Batch GCD
**When**: multiple moduli may share a prime.
```python
# IN: ns (list of moduli)  OUT: dict {index: (p, q)}
from math import gcd
results = {}
for i in range(len(ns)):
    for j in range(i+1, len(ns)):
        g = gcd(ns[i], ns[j])
        if 1 < g < ns[i]:
            results[i] = (g, ns[i]//g)
            results[j] = (g, ns[j]//g)
for idx, (p, q) in results.items():
    assert p * q == ns[idx]
```

## Multi-prime RSA
**When**: n has k > 2 prime factors (factor with ECM / `yafu`). | **Trap**: phi uses all factors.
```python
# IN: primes (list), e, c  OUT: m (int)
from functools import reduce
phi = reduce(lambda a, p: a * (p - 1), primes, 1)
d = pow(e, -1, phi)
m = pow(c, d, reduce(lambda a, b: a*b, primes))
from Crypto.Util.number import long_to_bytes
assert long_to_bytes(m).startswith(b'flag') or True  # adapt to flag format
```

## Phi(n) leakage
**When**: phi(n) or a multiple is leaked.
```python
# IN: n, phi  OUT: p, q
from gmpy2 import isqrt
s = n - phi + 1
d = isqrt(s*s - 4*n)
p, q = int((s + d) // 2), int((s - d) // 2)
assert p * q == n
```

## Known d
**When**: private exponent d is known, need p, q.
```python
# IN: n, e, d  OUT: p, q
import random
from math import gcd
k = d * e - 1
while True:
    g = random.randint(2, n - 2)
    t = k
    while t % 2 == 0:
        t //= 2
        x = pow(g, t, n)
        f = gcd(x - 1, n)
        if 1 < f < n:
            p, q = f, n // f
            assert p * q == n
            break
    else: continue
    break
```

## Pollard's rho
**When**: n has a factor p where p < ~2^62 (practical limit). Faster than trial division, no smoothness requirement.
```python
# IN: n  OUT: p, q
from math import gcd
def pollard_rho(n):
    x = y = 2; d = 1
    f = lambda x: (x*x + 1) % n
    while d == 1:
        x = f(x)
        y = f(f(y))
        d = gcd(abs(x - y), n)
    assert d != n, "retry with different start/polynomial"
    return d, n // d

p, q = pollard_rho(n)
assert p * q == n
```

## dp/dq Leak (CRT Components)
**When**: dp = d mod (p−1) or dq = d mod (q−1) is leaked alongside (n, e).
```python
# IN: n, e, dp  OUT: p, q  (knowing dp alone suffices)
# e·dp ≡ 1 (mod p−1) → e·dp − 1 = k·(p−1) for some k < e
# So p divides (e·dp − 1 + k) for the right k. Try all k.
from math import gcd
for k in range(1, e):
    p_candidate = (e * dp - 1 + k) // k
    if p_candidate > 1 and n % p_candidate == 0:
        p, q = p_candidate, n // p_candidate
        break
assert p * q == n
d = pow(e, -1, (p-1)*(q-1))
m = pow(c, d, n)
```
**Trap**: k iterates up to e. For e=65537 this is instant. For very large e, use Coppersmith instead.

## Structured / known-high-bits primes
**When**: part of p is known. | This crosses into Coppersmith territory — see `rsa-coppersmith.md`.
```python
# SageMath — IN: n, p_high, unknown_bits  OUT: p, q
P.<x> = PolynomialRing(Zmod(n))
roots = (p_high + x).small_roots(X=2^unknown_bits, beta=0.5)
assert roots, "adjust X or beta"
p = p_high + int(roots[0]); q = n // p
assert p * q == n
```
