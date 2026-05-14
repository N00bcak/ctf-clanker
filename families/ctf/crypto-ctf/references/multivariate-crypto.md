# Multivariate Cryptography Attacks

Attacks on multivariate polynomial signature schemes.

## Unbalanced Oil and Vinegar (UOV)

**Scheme**: Secret key partitions n variables into o "oil" variables
and v "vinegar" variables. Public key is a system of o quadratic
equations in n = v + o variables. To sign: choose random vinegar
values, solve the resulting linear system for oil values.

**Security assumption**: Without knowledge of the oil/vinegar
partition, solving a random system of quadratic equations is hard
(MQ problem).

### Direct Algebraic Attack

**When**: Parameters are weak (small o, v, or field size).

**How**: Solve the public system directly using Grobner bases
(F4/F5 algorithm) or XL algorithm.

```python
# SageMath — direct Grobner basis attack
# P is the list of public polynomials
# Variables x_1, ..., x_n
R = PolynomialRing(GF(q), 'x', n)
xs = R.gens()
I = R.ideal(public_polynomials)
gb = I.groebner_basis()
# If the system is solvable: gb gives the solution
```

**Complexity**: Exponential in general, but CTF challenges may
use deliberately weak parameters.

### Kipnis-Shamir Attack (Key Recovery)

**When**: Standard UOV with v = o (balanced — rarely used in practice).

**How**: Find the oil subspace from the public key by solving
a MinRank problem on the public key matrices.

### MinRank Attack

**When**: Applicable when the public key matrices have low rank
when restricted to the oil subspace.

**How**: The central map's quadratic forms, when evaluated on
oil-only vectors, yield zero. This gives a MinRank instance:
find a linear combination of the public matrices with rank ≤ v.

```python
# SageMath — MinRank via kernel method
# For each public polynomial P_i, form matrix M_i
# Find coefficients c_i such that rank(sum(c_i * M_i)) <= v
# This is a system of equations on the c_i
```

### Intersection Attack

Compute intersections of kernels of public key matrices to
recover information about the oil subspace. Effective when
the number of equations is small.

### Reconciliation / Equivalent Key

Find an equivalent secret key (different oil/vinegar partition
that produces the same public key) rather than the original.

## MAYO

**Scheme**: Based on UOV but uses a "whipping" technique to
reduce public key size. The public map is derived from a smaller
set of matrices via a mixing matrix.

### Attacks on MAYO

- **Rectangular MinRank**: MAYO's structure exposes a rectangular
  MinRank problem that can be easier than the standard UOV MinRank.
- **Wedge product attack** (2025): Uses exterior algebra to reduce
  UOV/MAYO security. Reduces security of standard UOV parameters
  by 4-20 bits depending on parameter set.

```python
# The wedge product attack constructs matrices in the exterior
# algebra and finds relations that reveal the oil subspace
# Complexity depends on n, o, v, and field size
```

## Rainbow

**Scheme**: Multi-layer UOV — variables are partitioned into
multiple layers, each building on the previous.

**Status**: Broken by Ward Beullens (2022) using a combination
of rectangular MinRank and intersection attacks. The attack
recovers the secret key in about a weekend on a laptop.

**CTF relevance**: May appear as "implement the known attack"
challenges or as historical examples.

## SNOVA

**Scheme**: Uses a block-ring structure on top of UOV.

**Attack**: The ring structure can be exploited via the wedge
product attack, as the block structure leaks additional algebraic
relations (2025 result).

## General Multivariate System Solving

For challenges that give a random-looking system of multivariate
quadratic equations:

```python
# SageMath
R = PolynomialRing(GF(q), 'x', n, order='degrevlex')
xs = R.gens()
system = [...]  # list of polynomials

# Try Grobner basis (may be slow for large n)
I = R.ideal(system)
variety = I.variety()  # all solutions

# For overdetermined systems (more equations than variables):
# Often much easier to solve
```

### XL (eXtended Linearization)

Multiply each equation by all monomials up to degree D,
then linearize (treat each monomial as a new variable)
and solve the resulting linear system. Effective when
the system is overdetermined.

### Hybrid Approach

Guess some variables to reduce the system, then solve the
smaller system with Grobner bases or linearization.

## Tools

```
sage                    # Grobner basis, variety computation
magma                   # Often faster for F4/F5 computation
msolve                  # Specialized multivariate system solver
```
