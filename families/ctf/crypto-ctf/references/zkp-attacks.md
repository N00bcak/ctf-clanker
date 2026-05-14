# Zero-Knowledge Proof Attacks

Attacks on ZKP systems in CTF challenges.

## Fiat-Shamir Heuristic Abuse

**When**: An interactive ZKP is made non-interactive using
Fiat-Shamir (challenge = hash of commitment), but the
implementation has flaws.

### Weak/Missing Hash

If the challenge is not properly bound to the commitment:

```python
# Vulnerable: challenge = H(message) instead of H(commitment || message)
# Attacker can choose commitment after seeing the challenge
# → forge proofs for any statement
```

### Replay Attack

If the verifier doesn't check freshness or uniqueness of proofs:

```python
# Resubmit a valid proof for a different context
# The proof is valid because the hash check passes regardless
```

## Schnorr Signature Forgery

**When**: Schnorr-like protocol with implementation flaws.

### Nonce Reuse

Same as ECDSA nonce reuse — if two signatures use the same
random nonce k, the private key is recoverable.

```python
# Given (e1, s1) and (e2, s2) with same r = g^k:
# s1 = k - x*e1, s2 = k - x*e2
# x = (s1 - s2) / (e2 - e1) mod q
```

### Predictable Nonce

If k is derived from a weak RNG or deterministic source,
brute-force k and recover x.

## Groth16 Attacks

**Scheme**: Most compact SNARK — proof is 3 group elements,
verification is 3 pairings. Requires trusted setup (CRS).

### Broken Setup (Toxic Waste Exposure)

**When**: The setup's "toxic waste" (trapdoor) is known or
recoverable.

```python
# If the trapdoor tau is known:
# Can forge proofs for any statement
# Proof: compute A, B, C from the CRS using tau
# instead of the actual witness
```

### Proof Replay

**When**: Proofs are not bound to a specific context.

```python
# Groth16 proofs are publicly verifiable
# If the same circuit is used for different contexts without
# binding, a proof from context A may verify in context B
```

### Constraint Underdetermination

**When**: The R1CS circuit has fewer constraints than needed,
allowing multiple valid witnesses including invalid ones.

```python
# If the prover can satisfy the constraints with a "wrong" witness
# that still produces a valid proof, the proof system is unsound
# CTF: find the loophole in the constraint system
```

### Malleability

Groth16 proofs are malleable — given a valid proof (A, B, C),
can produce a different valid proof for the same statement:

```python
# (A', B', C') = (A * r, B * r^(-1), C) for random r
# Verifies correctly but is a different proof
```

## PLONK / Lookup Attacks

**Scheme**: Universal SNARK using polynomial commitments (KZG).

### Unsound Custom Gates

If the custom gates in a PLONK circuit have algebraic relations
that allow cheating (extra satisfying assignments).

### Polynomial Commitment Forgery

**When**: KZG commitment scheme with weak/leaked setup.

If the structured reference string (SRS) tau is known:
evaluate polynomials at tau directly to forge commitments.

## Sigma Protocol Attacks

### AND/OR Composition

For composed proofs (prove A AND B, or prove A OR B):
flaws in the composition can allow proving one without the other.

### Simulator Extraction

In some protocols, the simulator (which exists for ZK property)
can be used by an attacker if the challenge space is small
enough to rewind and extract.

## Graph 3-Coloring ZKP

Common CTF challenge: a graph 3-coloring ZKP where the
verifier checks one edge per round.

**Attack**: If the prover commits to the coloring insecurely
(e.g., weak hash, deterministic permutation), extract the
full coloring from multiple rounds.

```python
# If the prover doesn't re-randomize the coloring each round:
# After 3 rounds revealing different edge endpoints,
# deduce the full coloring
```

## Garbled Circuit Attacks

**When**: Yao's garbled circuit protocol with implementation flaws.

### Free-XOR Delta Recovery

In the Free-XOR optimization, all wire labels differ by a
global delta. If delta leaks (e.g., through a timing oracle
or implementation bug), decrypt all wire labels.

### Point-and-Permute Bit Leakage

The select bit (LSB of labels) reveals which row of the
garbled table to decrypt. If an attacker can observe which
row is accessed, information about the circuit input leaks.

## Common CTF Patterns

| Challenge Type | Attack |
|---|---|
| Implement a ZKP prover | Find witness satisfying constraints |
| Break a ZKP verifier | Find input that verifier accepts without valid witness |
| Forge a proof | Exploit setup weakness or constraint gaps |
| Extract witness from proof | Not possible in theory; exploit implementation |
| Replay/reuse proofs | Missing context binding or freshness |
