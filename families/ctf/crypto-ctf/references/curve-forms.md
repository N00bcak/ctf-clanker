# Curve Forms and Conversions

Elliptic curves come in several forms. CTF challenges may use non-Weierstrass forms to confuse solvers or exploit form-specific properties.

## Edwards Curves
**Equation**: x² + y² = 1 + d·x²·y² over GF(p).
**Identity point**: (0, 1). **Negation**: (-x, y).
```python
# SageMath — IN: d, p  OUT: Edwards curve as EllipticCurve (Weierstrass form)
# Edwards → Weierstrass conversion:
# a = -(1 + d^2) / (1 - d^2)   (scale depends on convention)
# Or use built-in:
E = EllipticCurve(GF(p), [0, 2*(1+d)/(1-d), 0, 1, 0])  # Montgomery intermediate
```

## Twisted Edwards Curves
**Equation**: a·x² + y² = 1 + d·x²·y².
**Ed25519 uses**: a = -1, d = -121665/121666, p = 2²⁵⁵ − 19.
```python
# SageMath — Twisted Edwards (a,d) → Montgomery (A,B) → Weierstrass
# Birational map: (u,v) = ((1+y)/(1-y), (1+y)/((1-y)*x))
# Montgomery form: B·v² = u³ + A·u² + u  where A = 2(a+d)/(a-d), B = 4/(a-d)
F = GF(p)
A = F(2*(a+d)) / F(a-d)
B = F(4) / F(a-d)
# Montgomery → Weierstrass: substitute u = x - A/3
# Weierstrass: y² = x³ + (3-A²)/(3B²) · x + (2A³-9A)/(27B³)
a_w = F(3 - A^2) / F(3*B^2)
b_w = F(2*A^3 - 9*A) / F(27*B^3)
E = EllipticCurve(F, [a_w, b_w])
```

## Montgomery Curves
**Equation**: B·y² = x³ + A·x² + x.
**Curve25519 uses**: A = 486662, B = 1, p = 2²⁵⁵ − 19.
```python
# SageMath — Montgomery → Weierstrass
F = GF(p); A_val = F(A); B_val = F(B)
a_w = (3 - A_val^2) / (3 * B_val^2)
b_w = (2*A_val^3 - 9*A_val) / (27 * B_val^3)
E = EllipticCurve(F, [a_w, b_w])
# Point conversion: Weierstrass (x,y) ↔ Montgomery (u,v)
# u = x*B - A/3,  v = y*B
```

## Cofactor Issues
Ed25519 has cofactor h = 8 (curve order = 8 · l where l is prime). Attacks:

### Small-Subgroup / Torsion Points
```python
# SageMath — find torsion points (order dividing cofactor h)
E = EllipticCurve(GF(p), [a_w, b_w])
n = E.order()
l = n // 8  # prime subgroup order
# Torsion point: any point P where l*P ≠ identity but 8*l*P = identity
T = E.random_point() * l  # T has order dividing 8
assert 8 * T == E(0)
```

### Clamping Bypass
Ed25519 "clamps" private scalars: clear bits 0-2, set bit 254. If clamping is skipped, the key may have components in the order-8 subgroup → leaks info.

### Mixed-Order Validation
If the verifier doesn't multiply by cofactor (or check l·P = 0), accept attacker-chosen points from the twist or small subgroup. See `ecc-attacks.md` for invalid curve and twist attacks.

## Point Compression
```python
# Compressed point: (x, y_sign) → just x-coordinate + 1 bit for y's sign
# Decompress: solve y² = x³ + ax + b, pick y matching sign bit
y_squared = (x^3 + a*x + b) % p
y = pow(y_squared, (p+1)//4, p)  # for p ≡ 3 mod 4
if y % 2 != sign_bit:
    y = p - y
```

## When to Convert
| Challenge gives | You need | Action |
|---|---|---|
| Edwards (d, base, pub, order) | Weierstrass for SageMath DLP | Convert both curve and points |
| Montgomery (A, points) | Weierstrass | Convert curve, solve DLP, convert answer back |
| Weierstrass with cofactor | DLP on prime subgroup | Multiply points by cofactor first |
| Mixed: public key on twist | Twist attack | Compute twist order, Pohlig-Hellman if smooth |
