# RSA Small Exponent Attacks

Attacks exploiting a small public exponent e (typically e=3 or e=65537
with special conditions).

## Direct eth-Root

**When**: e is small (e=3 common), message m is small enough that
m^e < n (no modular reduction occurs).

**How**: c = m^e mod n, but if m^e < n then c = m^e exactly.
Recover m = c^(1/e) over the integers.

```python
# SageMath
from Crypto.Util.number import long_to_bytes
c = ...  # ciphertext
e = 3
m = ZZ(c).nth_root(e)
print(long_to_bytes(int(m)))
```

```python
# Python (gmpy2)
import gmpy2
m, exact = gmpy2.iroot(c, e)
if exact:
    print(long_to_bytes(int(m)))
```

**Gotchas**: If m^e is slightly larger than n (wrapped around once or
twice), try m = (c + k*n)^(1/e) for small k values.

```python
for k in range(10000):
    m, exact = gmpy2.iroot(c + k * n, e)
    if exact:
        print(long_to_bytes(int(m)))
        break
```

## Hastad Broadcast Attack

**When**: Same plaintext m encrypted with e different public keys
(n_1, n_2, ..., n_e) using small e. Requires e or more ciphertexts.

**How**: Use CRT to reconstruct m^e mod (n_1 * n_2 * ... * n_e),
then take the eth-root over the integers.

```python
# SageMath
from sage.all import CRT, ZZ
ns = [n1, n2, n3]  # for e=3
cs = [c1, c2, c3]
m_cubed = CRT(cs, ns)
m = ZZ(m_cubed).nth_root(3)
print(long_to_bytes(int(m)))
```

**Gotchas**: Moduli must be pairwise coprime. If gcd(n_i, n_j) > 1,
you can factor both moduli directly.

## Coppersmith Stereotyped Message

**When**: e is small, and you know most of the plaintext (e.g., known
prefix/suffix with a short unknown portion).

**How**: If m = m_known + x where x is small (|x| < n^(1/e)),
Coppersmith's method finds x in polynomial time.

```python
# SageMath
n = ...
e = 3
c = ...
known_prefix = b"The flag is: "
prefix_int = int.from_bytes(known_prefix, 'big') << (8 * unknown_bytes)

P.<x> = PolynomialRing(Zmod(n))
f = (prefix_int + x)^e - c
roots = f.small_roots(X=2^(8*unknown_bytes), beta=1.0)
if roots:
    m = prefix_int + int(roots[0])
    print(long_to_bytes(m))
```

**Key parameter**: X (upper bound on the unknown) must satisfy
X < n^(1/e). Larger e makes the bound tighter — works best with e=3.

**Variants**:
- Known suffix: shift the unknown to the high bits.
- Known middle: split into two unknowns (bivariate Coppersmith, harder).
- Multiple related plaintexts: see Franklin-Reiter.

## Franklin-Reiter Related Message Attack

**When**: Two messages m_1 and m_2 are related by a known linear
relationship m_2 = a*m_1 + b, both encrypted with the same (n, e).

**How**: Two polynomials f_1(x) = x^e - c_1 and
f_2(x) = (a*x + b)^e - c_2 share the root m_1. Compute
gcd(f_1, f_2) in Z_n[x] to recover m_1.

```python
# SageMath
def franklin_reiter(n, e, c1, c2, a, b):
    P.<x> = PolynomialRing(Zmod(n))
    f1 = x^e - c1
    f2 = (a*x + b)^e - c2
    return -gcd(f1, f2).coefficients()[0]  # constant term = -m (monic)

m = franklin_reiter(n, e, c1, c2, a, b)
print(long_to_bytes(int(m)))
```

**Gotchas**: Only efficient for small e. For e=3, the polynomial gcd
is fast. For larger e, use Coppersmith's short-pad attack instead.

## Common Modulus Attack
**When**: Same plaintext m encrypted with same n but two different public exponents e₁, e₂ where gcd(e₁, e₂) = 1.
```python
# IN: n, e1, e2, c1, c2  OUT: m
# Bezout: find a, b such that a*e1 + b*e2 = 1
from Crypto.Util.number import long_to_bytes
def common_modulus(n, e1, e2, c1, c2):
    from math import gcd
    assert gcd(e1, e2) == 1
    _, a, b = extended_gcd(e1, e2)
    # Handle negative exponents via modular inverse
    if a < 0:
        c1 = pow(c1, -1, n); a = -a
    if b < 0:
        c2 = pow(c2, -1, n); b = -b
    return pow(c1, a, n) * pow(c2, b, n) % n

def extended_gcd(a, b):
    if a == 0: return b, 0, 1
    g, x, y = extended_gcd(b % a, a)
    return g, y - (b // a) * x, x

m = common_modulus(n, e1, e2, c1, c2)
assert long_to_bytes(m).startswith(b'flag') or True
```
**Trap**: If gcd(e₁, e₂) = g > 1, you recover m^g mod n — take the gth root (may need Coppersmith if m^g > n).

## Coppersmith Short-Pad Attack

**When**: Same message encrypted twice with different small random
padding. Padding is short relative to message length.

**How**: Combine Franklin-Reiter with Coppersmith to first recover
the padding difference, then recover the message.

```python
# SageMath (e=3, padding in low bits)
# Step 1: find the difference between paddings
P.<x,y> = PolynomialRing(Zmod(n))
# If m1 = m*2^pad_bits + r1, m2 = m*2^pad_bits + r2
# Then m2 = m1 + (r2-r1), find (r2-r1) via resultant
# Step 2: use Franklin-Reiter with the recovered relationship
```

**Bound**: Padding must be < n^(1/e^2) bits for e=3, this means
padding < n^(1/9) ≈ 227 bits for 2048-bit n.
