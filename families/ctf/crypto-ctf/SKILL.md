---
name: crypto-ctf
description: >-
  Analyze and break cryptographic schemes in CTF challenges: RSA, ECC,
  symmetric ciphers, classical ciphers, PRNG, hashes. Uses mechanism-property
  analysis to identify weaknesses. Does not use subagents.
---

# Crypto CTF

## Purpose

Analyze cryptographic schemes, identify parameter weaknesses or protocol
flaws, and produce solvers that recover plaintext, keys, or flags.

## Use When

- The challenge involves a cryptosystem: RSA, ECC, AES, DES, classical
  ciphers, hash functions, PRNG, or custom crypto.
- Source code for a crypto implementation is provided.
- Parameters (public key, ciphertext, nonce, IV) are given to break.
- An encryption/decryption oracle is available.

## Do Not Use

- The cryptographic component is part of a web auth scheme — use `web-ctf`
  for the web layer, consult `crypto-ctf` only for the crypto math.
- The primary artifact is a binary implementing custom crypto — use
  `reverse-ctf` to recover the algorithm first.
- The category is unknown — use `ctf-triage` first.
- Do not spawn, request, or rely on subagents.

## Needs

- Crypto source code, parameters, or oracle access.
- Ciphertext, public key, or other challenge-provided data.
- Flag format or success condition.
- Number of oracle queries allowed (if limited).

## Returns

- Mechanism-property analysis of the cryptosystem.
- Identified weakness with mathematical justification.
- Solver script (SageMath or Python) that recovers the flag.
- If blocked, the specific mathematical barrier with evidence.

## Done Conditions

- The cryptographic weakness is identified and exploited.
- A solver produces the flag, or a clear mathematical blocker is documented.
- All assumptions about the cryptosystem are stated.

## Persistence And Yield

Useful progress means mechanism properties mapped, weakness class narrowed,
partial key recovery, oracle behavior characterized, mathematical structure
identified, or attack precondition confirmed.

Before yielding:

- Try the primary attack path based on mechanism analysis.
- Try one distinct bounded alternative (different attack family, different
  parameter relationship, alternative mathematical approach).
- Check whether missing information is derivable (factor database lookup,
  oracle probing, parameter relationship analysis).
- Confirm the next action would repeat prior work, require unsafe guessing,
  or leave this skill's boundary.

Do not yield merely because the math is hard or the cryptosystem is
unfamiliar. Build a mechanism-property ledger and search for fundamentals.

When yielding, return the analysis performed, mechanism properties mapped,
specific mathematical barrier, why more work would repeat, and the next
recovery step.

## Methodology

### Evidence-First Workflow

Start from the real cryptographic artifacts. Read the source code or
parameters before guessing the attack class.

```
python3 -c "print(len(str(n)))"        # RSA modulus size in digits
openssl x509 -in cert.pem -text        # certificate details
python3 -c "from Crypto.Util.number import *; print(isPrime(n))"
```

### Step 1: Build Mechanism-Property Ledger

For any cryptosystem, map these properties before selecting an attack:

| Property | What to determine |
|----------|-------------------|
| Algorithm | RSA, ECC, AES-CBC, custom, classical? |
| Parameters | Key size, modulus, curve, block size? |
| Key generation | How are keys chosen? Weak parameters? |
| Randomness | Nonce, IV, seed? Reused? Predictable? |
| Oracle access | Can you encrypt/decrypt/sign/verify? How many times? |
| Malleability | Can you modify ciphertext with predictable plaintext effect? |
| Error behavior | Do errors leak information (padding, timing)? |

### Step 2: Classify and Select Attack

Use the completed ledger to select one primary attack family and one
bounded fallback. Do not load every crypto reference.

Read `references/attack-selection.md` when the mechanism is known but
the attack class is not obvious. Then read only the specific reference
for the selected family.

### Step 3: Implement Solver

Use SageMath for number theory and algebra. Use PyCryptodome for symmetric
operations. Use Python for oracle interaction.

Keep solvers artifact-specific: parse the challenge inputs, assert attack
preconditions, recover the secret, and verify the flag format. Put reusable
or bulky helper logic in a solver script, not in the response.

### Step 4: Verify and Adapt

- Verify the solver produces a valid flag.
- If the flag format doesn't match, check endianness, encoding, or padding.
- If an oracle is involved, count queries to stay within limits.

### When Unfamiliar

If the mechanism is unfamiliar:

1. Build the property ledger anyway — the properties constrain which attacks apply.
2. Search for the exact algorithm name, parameter names, or error messages.
3. Prefer specs and papers over writeup blogs.
4. Re-ground every search result against the real artifacts.

## Pivot Rules

- If the cryptosystem is implemented in a binary that must be reversed first,
  hand off to `reverse-ctf` to recover the algorithm.
- If the crypto is embedded in a web authentication flow (JWT, OAuth, session
  tokens), the web layer belongs to `web-ctf`.
- If the crypto challenge involves network traffic analysis, the capture
  analysis belongs to `forensics-ctf`.

## Reference

- `references/mechanism-property-ledger.md` — universal analysis framework
- `references/attack-selection.md` — compact attack-family chooser
- Read only the specific family reference needed next: RSA, ECC, block
  modes, PRNG/LFSR, hashes/MACs, lattices, post-quantum, signatures,
  secret sharing, finite fields, Feistel/custom ciphers, or obscure public-key systems.
