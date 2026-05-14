# Feistel Network Analysis

Custom block ciphers in CTF are frequently Feistel-structured. These attacks apply to any Feistel cipher with identifiable weaknesses.

## Feistel Structure Recognition
```
L₀, R₀ = split(plaintext)
for i in range(rounds):
    L_{i+1} = R_i
    R_{i+1} = L_i ⊕ F(R_i, K_i)
ciphertext = L_rounds || R_rounds
```
**Decryption**: reverse the round order and swap L/R — no inverse of F needed.

## Differential Cryptanalysis
**When**: F has a differential with high probability (input diff → output diff). Low round count (≤ 6 rounds).
```python
# IN: encrypt_oracle(pt) → ct, round function F properties  OUT: key bytes
# Step 1: Find a high-probability differential for F
# ΔX → ΔY with probability p (ideally p > 2^(-block_bits/2))

# Step 2: Generate chosen plaintext pairs with input difference ΔX
# Encrypt both, check if output difference matches expected ΔY

# Step 3: For pairs that match, the last-round key is constrained
# Count key candidates — correct key has highest count

# Example for 3-round Feistel:
# P1 = (L, R), P2 = (L ⊕ ΔL, R)  (difference only in left half)
# After 3 rounds: output difference depends on K3
# For each candidate K3: partially decrypt last round, check if
# the intermediate difference matches the expected differential
from collections import Counter
key_counts = Counter()
for L, R in plaintext_pairs:
    C1 = encrypt(L, R)
    C2 = encrypt(L ^ delta_L, R)
    for k3_candidate in range(key_space):
        # Partially decrypt last round with k3_candidate
        intermediate = partial_decrypt(C1, C2, k3_candidate)
        if matches_differential(intermediate):
            key_counts[k3_candidate] += 1

key = key_counts.most_common(1)[0][0]
```

## Slide Attack
**When**: All rounds use the same key (or keys repeat cyclically). Any number of rounds.
```python
# IN: encrypt_oracle  OUT: round key
# If K_i = K for all i, then shifting the entire cipher by one round
# gives an equivalent encryption with a "slid" pair:
# E(P1) uses rounds 1..N, and there exists P2 such that
# E(P2) uses "rounds 2..N+1" which equals F_K applied to E(P1)

# Find slid pair: encrypt many random plaintexts, look for (P1, P2) where
# one round of F maps P1 to a state that aligns with P2's encryption path
# This reduces the N-round cipher to a 1-round problem

# PlaidCTF 2022 "choreography" used Complementation Slide + Twisted Slide
```

## Meet-in-the-Middle
**When**: Key is split across rounds (K1 for first half, K2 for second half).
```python
# IN: known (plaintext, ciphertext) pairs  OUT: K1, K2
# Encrypt plaintext forward through first half with all K1 candidates
# Decrypt ciphertext backward through second half with all K2 candidates
# Match in the middle

forward = {}
for k1 in range(2**key1_bits):
    mid = encrypt_half1(plaintext, k1)
    forward[mid] = k1

for k2 in range(2**key2_bits):
    mid = decrypt_half2(ciphertext, k2)
    if mid in forward:
        K1, K2 = forward[mid], k2
        break
# Verify on a second (pt, ct) pair
assert encrypt(plaintext2, K1, K2) == ciphertext2
```

## Weak Round Function
**When**: F is linear or has low algebraic degree.
```python
# If F is linear: F(a ⊕ b) = F(a) ⊕ F(b)
# → entire cipher is an affine function of the plaintext
# → solve with known plaintext/ciphertext pairs (linear algebra)

# If F has degree 2: consider higher-order differential attack
# 2^d chosen plaintexts covering all d-bit subspaces → d-th order differential
```

## Unbalanced Feistel
**When**: L and R halves have different sizes, or F takes extra inputs.
The analysis principles are the same, but the differential probabilities and slide conditions change. Identify the structure first, then adapt.

## SPN Components Inside Feistel
**When**: F contains substitution (S-box) + permutation (P-box).
```python
# Analyze the S-box:
# DDT (Difference Distribution Table): for each input/output difference pair,
# count how many inputs produce that pair
DDT = [[0]*256 for _ in range(256)]
for dx in range(256):
    for x in range(256):
        dy = SBOX[x] ^ SBOX[x ^ dx]
        DDT[dx][dy] += 1
# High entries in DDT → exploitable differentials
max_prob = max(DDT[dx][dy] for dx in range(1,256) for dy in range(256)) / 256
```

## Tools
```python
# SageMath: matrix operations for linear analysis
# Custom scripts for DDT computation
# CryptoSMT: automated differential/linear trail search
```
