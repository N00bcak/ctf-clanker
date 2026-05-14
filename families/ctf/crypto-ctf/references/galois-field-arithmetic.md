# Galois Field Arithmetic

## GF(2^n) — Binary Extension Field
```python
# SageMath — IN: a_int, b_int, modulus polynomial  OUT: sum, product as ints
F.<a> = GF(2^8, modulus=x^8+x^4+x^3+x+1)  # AES field
x_el = F.fetch_int(0xA3); y_el = F.fetch_int(0x5B)
s = (x_el + y_el).integer_representation()  # addition = XOR
p = (x_el * y_el).integer_representation()  # poly mult mod p(x)
inv = (x_el^(-1)).integer_representation()  # inverse
assert F.fetch_int(s) == x_el + y_el
assert F.fetch_int(p) == x_el * y_el
```
```python
# Pure Python GF(2^8) multiply — IN: a, b (ints 0–255)  OUT: product
def gf_mult(a, b, mod=0x11B):
    r = 0
    while b:
        if b & 1: r ^= a
        a <<= 1
        if a & 0x100: a ^= mod
        b >>= 1
    return r
assert gf_mult(0xA3, 0x5B) == gf_mult(0x5B, 0xA3)  # commutativity
```

## GF(p) — Prime Field
```python
# SageMath — IN: p, val  OUT: inverse, sqrt, log
F = GF(p); a = F(val)
a_inv = a^(-1); assert a * a_inv == 1
# sqrt: a.sqrt() — exists iff a^((p-1)/2) == 1 (Euler criterion)
# dlog: a.log(g) — discrete log base g
```

## GF(p^k) — Extension Field
```python
# SageMath — IN: p, k  OUT: field with arithmetic
R.<x> = PolynomialRing(GF(p))
F.<a> = GF(p^k, modulus=R.irreducible_element(k))
# a is the generator; use F(coefficients) or a^i for elements
```

## Linear System over GF(2)
```python
# SageMath — IN: M (matrix), b (vector) over GF(2)  OUT: solution x
M = matrix(GF(2), [[1,0,1,1],[0,1,1,0],[1,1,0,1]])
b = vector(GF(2), [1,0,1])
x = M.solve_right(b)
assert M * x == b
# Null space: M.right_kernel().basis()
```
Use for: LFSR state recovery, CRC manipulation, MT19937, linear cryptanalysis.

## Polynomial Arithmetic over GF(2)
```python
# SageMath — IN: polynomial  OUT: factored, irreducibility check, CRC
R.<x> = PolynomialRing(GF(2))
f = x^8 + x^4 + x^3 + x + 1
assert f.is_irreducible()
# CRC-16-CCITT
gen = x^16 + x^12 + x^5 + 1
msg = R([1,0,1,1,0,0,1])
crc = (msg * x^16) % gen
```

## CRC Exploitation
CRC is linear over GF(2): CRC(A ⊕ B) = CRC(A) ⊕ CRC(B).
```python
# Forge message with target CRC
# IN: original (bytes), target_crc, crc_func  OUT: modified (bytes)
# Compute CRC basis vectors for each bit position, solve GF(2) system
# to find which bits to flip so CRC(modified) == target_crc.
```

## DLP in Extension Fields
**When**: DH in GF(p^k)* with small p. | DLP may be subexponential or quasi-polynomial.
```python
# SageMath — IN: p, k, g, h (h = g^x)  OUT: x
F.<a> = GF(p^k); g = F.multiplicative_generator(); h = g^42
x = h.log(g)
assert g^x == h
```
