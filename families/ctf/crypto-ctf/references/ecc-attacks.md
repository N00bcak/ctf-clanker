# Elliptic Curve Cryptography Attacks

## Invalid Curve Attack
**When**: Server does not validate that received points lie on the correct curve.
```python
# SageMath — IN: p, a (curve param), server_oracle(point)->shared_secret  OUT: private key
# Strategy: send points on curves with small-order subgroups, recover key mod each order via CRT
results = []
for b_prime in range(1, 200):
    try:
        E2 = EllipticCurve(GF(p), [a, b_prime])
        order = E2.order()
        for q, _ in factor(order):
            if q < 1000 and q > 2:
                G2 = E2.random_point() * (order // q)
                if G2.order() == q:
                    # Send G2 to server, get response = G2 * private_key
                    resp = server_oracle(G2)
                    for x in range(q):
                        if G2 * x == resp:
                            results.append((x, q)); break
    except: continue

from sage.all import CRT
key = CRT([r for r,_ in results], [m for _,m in results])
# Verify: original_curve_G * key should equal public_key
```

## ECDSA Nonce Reuse
**When**: Two signatures share the same r value (identical nonce k).
```python
# IN: q (curve order), r, s1, s2, h1, h2 (hash ints)  OUT: private_key d
k = ((h1 - h2) * pow(s1 - s2, -1, q)) % q
d = ((s1 * k - h1) * pow(r, -1, q)) % q
# Verify
assert (s1 * k - h1) * pow(r, -1, q) % q == d
assert (s2 * k - h2) * pow(r, -1, q) % q == d
```

## Biased Nonce / Hidden Number Problem
**When**: ECDSA nonces have known bias (top L bits are zero, or nonce derived from truncated hash).
```python
# SageMath — IN: signatures [(r_i, s_i, h_i)], q, L (known bits)  OUT: d
# Rearrange: k_i ≡ s_i^{-1}·(h_i + d·r_i) mod q → t_i ≡ d·a_i + e_i mod q, |e_i| < 2^(n-L)
# Build CVP/LLL lattice
n_sigs = len(sigs)
B = 2^(q.nbits() - L)
M = matrix(ZZ, n_sigs + 2, n_sigs + 2)
for i in range(n_sigs):
    M[i, i] = q
a_vals = [ZZ(pow(int(s), -1, int(q)) * int(r) % int(q)) for r, s, h in sigs]
t_vals = [ZZ(pow(int(s), -1, int(q)) * int(h) % int(q)) for r, s, h in sigs]
for i in range(n_sigs):
    M[n_sigs, i] = a_vals[i]
    M[n_sigs+1, i] = t_vals[i]
M[n_sigs, n_sigs] = B / q
M[n_sigs+1, n_sigs+1] = B
L_reduced = M.LLL()
# Extract d from the short vector (row where position n_sigs has small value)
# d = round(short_vector[n_sigs] * q / B) mod q
```
Typically need ≥ ceil(log₂(q) / L) signatures.

## Smart's Attack (Anomalous Curves)
**When**: Curve order == field prime p (trace of Frobenius = 1).
```python
# SageMath — IN: E (curve over GF(p)), P, Q (Q = d·P)  OUT: d
def smart_attack(P, Q, p):
    E = P.curve()
    Eqp = EllipticCurve(Qp(p, 2), [ZZ(a) + randint(0,p)*p for a in E.a_invariants()])
    P_lift = Eqp.lift_x(ZZ(P.xy()[0]), all=True)
    Q_lift = Eqp.lift_x(ZZ(Q.xy()[0]), all=True)
    for Pl in P_lift:
        for Ql in Q_lift:
            try:
                lP = -(Pl * p).xy()[0] / (2 * Pl.xy()[1])
                lQ = -(Ql * p).xy()[0] / (2 * Ql.xy()[1])
                d = ZZ(lQ / lP) % p
                if P * d == Q: return d
            except: continue
    return None

d = smart_attack(P, Q, p)
assert P * d == Q
```
**Detection**: `E.order() == p` or `E.trace_of_frobenius() == 1`.

## MOV Attack (Supersingular Curves)
**When**: Embedding degree k is small (k ≤ 6 typically exploitable).
```python
# SageMath — IN: E, P, Q, embedding_degree k  OUT: d
# Transfer ECDLP to DLP in GF(p^k)* via Weil pairing
E_ext = E.change_ring(GF(p^k))
n = P.order()
# Find a point R of order n in E(GF(p^k)) not in <P>
R = E_ext.random_point() * (E_ext.order() // n)
while R.weil_pairing(E_ext(P), n) == 1:
    R = E_ext.random_point() * (E_ext.order() // n)

alpha = E_ext(P).weil_pairing(R, n)
beta = E_ext(Q).weil_pairing(R, n)
d = beta.log(alpha)  # DLP in GF(p^k)*
assert P * d == Q
```
**Detection**: Check k with `for k in range(1,20): if (p^k - 1) % E.order() == 0: print(k); break`.

## Singular Curve
**When**: Curve discriminant = 0 (not a real elliptic curve). | **Trap**: SageMath refuses to create singular curves — use raw polynomial arithmetic.
```python
# SageMath — Node case: y^2 = x^3 + a·x^2 (double root at 0)
# Map to GF(p)*: phi(x,y) = (y + sqrt(a)·x) / (y - sqrt(a)·x)
# DLP in GF(p)* is easy
p = ...; a = ...
sqrt_a = GF(p)(a).sqrt()
def to_mult(x, y):
    return GF(p)((y + sqrt_a * x) / (y - sqrt_a * x))
u = to_mult(Px, Py)  # map base point
v = to_mult(Qx, Qy)  # map target
d = v.log(u)          # DLP in GF(p)*
# Verify: P * d == Q on the original curve (compute manually)
```

## Pohlig-Hellman
**When**: Curve order has only small prime factors.
```python
# SageMath — IN: E, P, Q  OUT: d
order = E.order()
parts, mods = [], []
for q, e in factor(order):
    Pi = P * (order // q^e)
    Qi = Q * (order // q^e)
    di = discrete_log(Qi, Pi, ord=q^e, operation='+')
    parts.append(di); mods.append(q^e)
d = CRT(parts, mods)
assert P * d == Q
```

## Twist Attack
**When**: Server doesn't check if a point is on the curve or its quadratic twist. The twist may have a smoother order.
```python
# SageMath — twist has equation y^2 = x^3 + a·x + b·c where c is a non-residue mod p
# E_twist order = 2·(p+1) - E.order()
E_twist_order = 2 * (p + 1) - E.order()
# If E_twist_order is smooth: send twist points, Pohlig-Hellman, CRT
```
