# Isogeny-Based Cryptography

Elliptic curve isogenies and their use in post-quantum cryptography.

## Background

An **isogeny** is a morphism between elliptic curves that is also
a group homomorphism. The degree of an isogeny corresponds to the
size of its kernel.

**Isogeny graph**: Vertices are (isomorphism classes of) elliptic
curves over F_p, edges are isogenies of a fixed degree. For
supersingular curves, this graph is a Ramanujan graph (good expander).

## SIDH / SIKE (Broken)

**Scheme**: Alice and Bob walk different directions in the
supersingular isogeny graph using 2^a and 3^b isogenies respectively.
They exchange curve images and torsion point images to derive a
shared secret.

**Status**: **Completely broken** by Castryck-Decru (2022) and
subsequent improvements. The attack recovers the private isogeny
in polynomial time.

### Castryck-Decru Attack

**Key insight**: SIDH publishes images of torsion points under the
secret isogeny. This auxiliary information, combined with Kani's
reducibility criterion for isogenies between products of elliptic
curves, allows constructing an explicit isogeny that reveals the secret.

```python
# SageMath (simplified outline)
# Given: E_A = phi_A(E_0), and images phi_A(P_B), phi_A(Q_B)
# where P_B, Q_B generate E_0[3^b]

# Step 1: Construct the (2,2)-isogeny graph on E × E'
# Step 2: Use Kani's theorem to factor through product abelian varieties
# Step 3: The endomorphism structure forces a unique decomposition
# Step 4: Extract phi_A from the decomposition

# Practical implementations:
# - https://github.com/GiacomoPope/Castryck-Decru-SageMath
# - Breaks SIKE-p434 in ~1 hour on a laptop
```

**CTF relevance**: May appear as "implement the known attack"
challenges or as understanding exercises.

### Why CSIDH Survives

CSIDH does not publish torsion point images — it only publishes
the image curve. Without auxiliary point information, the
Castryck-Decru attack does not apply.

## CSIDH

**Scheme**: Commutative Supersingular Isogeny DH. Uses the class
group action of the ideal class group on supersingular curves
defined over F_p (not F_p^2 as in SIDH).

**Security**: Based on the hardness of the group action inverse
problem. Quantum attacks exist (subexponential via Kuperberg/
Regev), so parameter sizes are large.

### Attacks on CSIDH

- **Torsion point attacks** (limited): Without auxiliary points,
  must use generic methods.
- **Kuperberg's algorithm**: Quantum algorithm, subexponential.
  Determines CSIDH parameter choices.
- **MITM on ideal class group**: For small class groups, meet-in-
  the-middle on the group structure.

```python
# SageMath — CSIDH toy example
p = 431  # prime such that p = 4 * l1 * l2 * ... * ln - 1
E0 = EllipticCurve(GF(p), [0, 6, 0, 1, 0])  # starting curve

# The class group acts via small-degree isogenies
# Secret key: vector of exponents [e1, e2, ..., en]
# Public key: E_A = [e1]l1 * [e2]l2 * ... * [en]ln (E0)
```

## SQIsign

**Scheme**: Signature scheme based on the quaternion isogeny
path problem. Uses the Deuring correspondence between
supersingular curves and maximal orders in quaternion algebras.

**Security**: Not affected by SIDH attacks. Currently a NIST
PQC round candidate.

### Attacks

- Based on the difficulty of computing isogenies between
  supersingular curves given only the curves (no auxiliary points)
- Quantum attacks: exponential (no known subexponential quantum attack)
- Classical: computing the endomorphism ring is hard

## Isogeny Path Problems

| Problem | Description | Hardness |
|---|---|---|
| SSIP (Supersingular Isogeny Problem) | Find isogeny between two curves | Hard (classical & quantum) |
| Endomorphism Ring | Compute End(E) | Equivalent to SSIP |
| SIDH with auxiliary points | Find isogeny given point images | **Broken** (polynomial time) |
| Group Action Inversion (CSIDH) | Find secret exponents from image curve | Hard (subexp quantum) |
| Vectorization | Find relation in class group from two curves | Related to GAIP |

## j-Invariant and Modular Polynomials

The j-invariant classifies elliptic curves up to isomorphism
over algebraically closed fields. Isogenies of degree l
correspond to roots of the modular polynomial Phi_l(X, Y):

```python
# SageMath
# Phi_l(j(E1), j(E2)) = 0 iff there exists an l-isogeny E1 → E2
j_source = E.j_invariant()
R.<X> = GF(p)[]
# Roots of Phi_l(j_source, X) give j-invariants of l-isogenous curves
```

## CTF Patterns

| Challenge | Approach |
|---|---|
| SIDH key recovery | Implement Castryck-Decru |
| CSIDH small parameters | MITM on class group |
| Find isogeny path | BFS/DFS in isogeny graph (small p) |
| Compute j-invariant chain | Modular polynomial evaluation |
| Endomorphism ring computation | Deuring correspondence |
