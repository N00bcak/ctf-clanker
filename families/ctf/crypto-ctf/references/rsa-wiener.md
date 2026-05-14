# RSA Wiener & Boneh-Durfee

## Wiener's Attack
**When**: d < n^0.25 (equivalently, e ≈ n). | **Trap**: use SageMath `continued_fraction`; manual CF code is error-prone.
```python
# SageMath — IN: e, n  OUT: d
from Crypto.Util.number import long_to_bytes
from gmpy2 import isqrt

def wiener(e, n):
    for c in continued_fraction(e / n).convergents():
        k, d = c.numerator(), c.denominator()
        if k == 0: continue
        phi = (e * d - 1) // k
        s = n - phi + 1
        disc = s*s - 4*n
        if disc < 0: continue
        sq = isqrt(disc)
        if sq*sq == disc and (s+sq) % 2 == 0:
            p = (s + sq) // 2; q = (s - sq) // 2
            if p * q == n: return int(d)
    return None

d = wiener(e, n)
assert d is not None, "Wiener failed — d may exceed n^0.25"
m = pow(c, d, n)
assert long_to_bytes(int(m))  # verify decryption produces readable output
```
**Automated**: `RsaCtfTool --publickey key.pub --private --attack wiener`

## Boneh-Durfee
**When**: d < n^0.292 (Wiener failed but d is still small). | Uses bivariate Coppersmith — see `rsa-coppersmith.md`.

**Implementation**: use `https://github.com/mimoo/RSA-and-LLL-attacks` directly. Key parameter: `delta = log(d)/log(n)` must be < 0.292. Try Wiener first; Boneh-Durfee is slower.

## Detection
Suspect small-d when: e is very large (close to n), e > n^0.5, or challenge mentions "efficient decryption" / "small private key".
