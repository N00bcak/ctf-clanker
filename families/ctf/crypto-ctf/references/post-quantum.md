# Post-Quantum Cryptography Attacks

Attacks on lattice-based, code-based, and other post-quantum schemes
appearing in CTF challenges.

## Learning With Errors (LWE)

**Problem**: Given (A, b = A*s + e mod q) where A is random,
s is the secret, and e is small error, recover s.

### Small Dimensions

For small n (dimension), reduce to SVP/CVP on the lattice.

```python
# SageMath — solve small LWE via lattice reduction
n, q = 20, 1009
A = ...  # n×m matrix over Z_q
b = ...  # m-vector

# Kannan's embedding: append b as extra row
# Short vector in the lattice reveals (s, e)
m = A.ncols()
M = matrix(ZZ, m + n + 1, m + n + 1)
M[:m, :m] = identity_matrix(m) * q
M[m:m+n, :m] = A
M[m+n, :m] = b
M[m:m+n, m:m+n] = identity_matrix(n)
M[m+n, m+n] = 1

L = M.BKZ(block_size=20)
# Check rows for short vectors containing s
```

### Dual Attack

When the number of samples m is large relative to n:
find a short vector w such that w*A ≡ 0 mod q, then
w*b = w*e gives a small value (distinguisher).

### Primal Attack

Directly search for (s, e) as a short vector in the
embedding lattice using BKZ.

## Ring-LWE

**Problem**: Same as LWE but in the polynomial ring
R_q = Z_q[x]/(x^n + 1) (typically n is a power of 2).

**Advantage for attacker**: The ring structure can sometimes
be exploited. For small n or weak parameters:

```python
# SageMath
R.<x> = PolynomialRing(Zmod(q))
f = x^n + 1  # cyclotomic polynomial
Rq = R.quotient(f)

# Given (a, b = a*s + e in Rq):
# Reduce to LWE by expanding polynomials into matrix form
# Or exploit algebraic structure
```

### Subfield Attack

If n has non-trivial factors, the ring decomposes into
sub-rings. Solving the problem in a smaller sub-ring
may suffice.

### Overstretched Parameters

If q is too large relative to n and the error bound,
standard lattice attacks become efficient.

## Module-LWE (ML-KEM / Kyber)

ML-KEM (formerly CRYSTALS-Kyber, FIPS 203) uses Module-LWE:
matrices of ring elements instead of single ring elements.

**CTF attacks**: Usually exploit implementation bugs,
parameter misuse, or oracle access rather than breaking
the underlying problem directly.

## NTRU

**Problem**: Given h = f^(-1) * g mod q in Z_q[x]/(x^n-1),
recover the short polynomials f and g.

```python
# SageMath — NTRU lattice attack
# Construct the NTRU lattice
n = ...
q = ...
h = ...  # public key polynomial (coefficients)

# Lattice basis: [qI | 0] and [H | I] where H is circulant from h
M = matrix(ZZ, 2*n, 2*n)
M[:n, :n] = identity_matrix(n) * q
for i in range(n):
    for j in range(n):
        M[n+i, j] = h_coefficients[(j - i) % n]
M[n:, n:] = identity_matrix(n)

L = M.BKZ(block_size=30)
# Short vector gives (f, g) or a rotation thereof
```

**Weak parameters**: If f and g are too short relative to q and n,
LLL/BKZ recovers them directly.

## Approximate GCD

**Problem**: Given x_i = p * q_i + r_i where p is secret,
q_i are large, r_i are small errors. Recover p.

Common in fully homomorphic encryption (DGHV scheme).

```python
# SageMath — simultaneous approximate GCD
# Given samples x_0, x_1, ..., x_m
# Build lattice:
m = len(samples) - 1
M = matrix(ZZ, m + 1, m + 1)
M[0, 0] = 2^(rho + 1)  # rho = error bit-length
for i in range(1, m + 1):
    M[i, 0] = samples[i]
    M[i, i] = -samples[0]

L = M.LLL()
# The short vector's first entry / 2^(rho+1) ≈ q_0/q_i ratios
# Recover p from: p = gcd(x_0 - r_0, x_1 - r_1)
# where r_i can be estimated from the short vector
```

### Orthogonal Lattice Attack

Build a lattice from the samples and find vectors orthogonal
to the secret. Particularly effective when the error is very
small relative to the modulus.

## Learning With Rounding (LWR)

**Problem**: Like LWE but error is deterministic: b = round(A*s * p/q).

**Attacks**: Reduction to LWE. The deterministic error is equivalent
to uniform error within a bounded range. Same lattice attacks apply,
but the error distribution's structure can sometimes be exploited.

## Lattice Reduction Quality

| Algorithm | Approximation Factor | Speed |
|---|---|---|
| LLL | 2^((n-1)/2) | Fast (polynomial) |
| BKZ-β | ~β^(n/β) | Slower, depends on β |
| BKZ-20 | Good for n < 100 | Minutes |
| BKZ-40 | Good for n < 200 | Hours |
| BKZ-60+ | Needed for hardened params | Days+ |

**Rule of thumb**: If the shortest vector is expected to be
much shorter than the Gaussian heuristic σ_1 ≈ sqrt(n/(2πe)) * det(L)^(1/n),
LLL/BKZ will likely find it.

## Tools

```
sage                    # LLL, BKZ, polynomial rings
fpLLL / flatter         # fast lattice reduction
estimator.py            # lattice-estimator for LWE parameters
```
