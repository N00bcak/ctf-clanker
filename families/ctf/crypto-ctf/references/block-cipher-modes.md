# Block Cipher Mode Attacks

Attacks on specific block cipher modes of operation.

## ECB Mode

**When**: AES-ECB or any block cipher in ECB mode. Each block
encrypted independently with the same key.

### Detection
Identical plaintext blocks produce identical ciphertext blocks.
If you see repeated 16-byte blocks in the ciphertext, it's ECB.

### Byte-at-a-Time Oracle

**When**: You control a prefix/suffix to an unknown plaintext that
is then encrypted with ECB.

```python
# Recover unknown plaintext one byte at a time
# Attacker controls prefix, oracle encrypts: AES-ECB(prefix || secret)

block_size = 16

# Step 1: determine block size (send increasing A's until output jumps)
# Step 2: for each byte position:
#   - send (block_size - 1 - i) A's so the next unknown byte
#     is at a block boundary
#   - brute-force the last byte by comparing blocks
for i in range(len(secret)):
    padding = b'A' * (block_size - 1 - (i % block_size))
    target_block = oracle(padding)[block_num * 16 : (block_num + 1) * 16]
    for byte in range(256):
        test = padding + known + bytes([byte])
        if oracle(test)[block_num * 16 : (block_num + 1) * 16] == target_block:
            known += bytes([byte])
            break
```

### Block Shuffling

**When**: ECB-encrypted data where block order matters (e.g., role
field in a cookie: `role=user` → `role=admin`).

**How**: Register with crafted input so `admin` is aligned to its
own block, then swap that block into the role position.

## CBC Padding Oracle

**When**: AES-CBC with PKCS#7 padding and a padding validity oracle.

**How**: Modify the previous ciphertext block byte-by-byte. When
the padding oracle returns "valid", the XOR relationship reveals
the intermediate state, enabling decryption without the key.

```python
# Decrypt one block (C_i) using the oracle
# P_i = D(C_i) XOR C_{i-1}
# Modify C_{i-1}' byte-by-byte to create valid padding

def decrypt_block(oracle, c_prev, c_target, block_size=16):
    intermediate = bytearray(block_size)
    plaintext = bytearray(block_size)

    for pad_byte in range(1, block_size + 1):
        pos = block_size - pad_byte
        for guess in range(256):
            c_mod = bytearray(c_prev)
            # Set already-known bytes to produce desired padding
            for j in range(pos + 1, block_size):
                c_mod[j] = intermediate[j] ^ pad_byte
            c_mod[pos] = guess
            if oracle(bytes(c_mod) + c_target):
                intermediate[pos] = guess ^ pad_byte
                plaintext[pos] = intermediate[pos] ^ c_prev[pos]
                break

    return bytes(plaintext)
```

**Queries**: At most 256 * block_size = 4096 per block.

## CBC Bit-Flip

**When**: You know the plaintext at a specific position in a
CBC-encrypted message and want to change it.

**How**: Flipping bit j in ciphertext block C_{i-1} flips the
same bit in plaintext block P_i (at the cost of corrupting P_{i-1}).

```python
# Change plaintext byte at position pos in block i
# XOR the corresponding byte in C_{i-1}
c = bytearray(ciphertext)
block_i = pos // block_size
byte_in_block = pos % block_size
prev_block_start = (block_i - 1) * block_size

c[prev_block_start + byte_in_block] ^= known_byte ^ desired_byte
```

**Gotchas**: Corrupts the previous block. If that block contains
structured data (e.g., JSON), the corruption may cause a parse error.

## CBC IV = Key

**When**: The encryption key is reused as the IV.

**How**: If you can cause the server to decrypt a chosen ciphertext
and observe the result, send C = [C1, 0, C1]. The server computes:
P3 = D(C1) XOR 0 = D(C1), and P1 = D(C1) XOR IV = D(C1) XOR Key.
So Key = P1 XOR P3.

## CBC-MAC Forgery

**When**: CBC-MAC is used without proper length encoding or domain
separation.

**How**: If you know MAC(m1) = t1, you can forge MAC(m1 || (m2 XOR t1))
= MAC(m2) for any m2 you can MAC. This is the length-extension
equivalent for CBC-MAC.

## CTR Nonce Reuse

**When**: AES-CTR with a reused nonce (counter starts at the same
value for two different plaintexts).

**How**: c1 XOR c2 = p1 XOR p2. If p1 is known (or partially known),
recover p2 directly.

```python
# XOR two ciphertexts encrypted with same keystream
xored = bytes(a ^ b for a, b in zip(c1, c2))
# If p1 is known: p2 = xored XOR p1
# If neither is known: use crib-dragging
```

### Crib Dragging

Drag a known word (crib) across the XOR of two ciphertexts.
At the correct position, the result is readable English/ASCII.

## CTR Bit-Flip

**When**: AES-CTR ciphertext where you know the plaintext position.

**How**: CTR is a stream cipher — flipping a bit in the ciphertext
flips the corresponding bit in the plaintext with no side effects.

## GCM Nonce Reuse

**When**: AES-GCM with repeated nonce. More severe than CTR nonce
reuse because it also breaks authentication.

**How**: Two authentications with the same nonce reveal the
authentication key H via polynomial GCD over GF(2^128). Once H
is known, forge arbitrary tags.

```python
# SageMath
# Given two (ciphertext, tag) pairs with same nonce
# Build polynomials T1(H) and T2(H) over GF(2^128)
# gcd(T1 - tag1, T2 - tag2) reveals H
F.<x> = GF(2^128, modulus=...)  # GCM polynomial
# ... construct and solve
```

## PCBC (Propagating CBC)
**When**: Challenge uses PCBC mode (each block's plaintext XOR ciphertext feeds into next block).
```python
# PCBC: C_i = E(P_i ⊕ P_{i-1} ⊕ C_{i-1})
# Vulnerability: if you swap two adjacent ciphertext blocks, only those two blocks
# are affected — the error does NOT propagate further (unlike CBC).
# This enables block manipulation attacks similar to ECB.

# Attack: if you know P_i, you can compute the feedback value and forge subsequent blocks
# Decryption: P_i = D(C_i) ⊕ P_{i-1} ⊕ C_{i-1}
# Key observation: P_i ⊕ C_i = D(C_{i+1}) ⊕ P_{i+1} enables chain recovery
```
**Trap**: PCBC is rare in real-world use but appears in CTF (e.g., HITCON 2024). The key insight is that the XOR of plaintext and ciphertext of each block is the "feedback" — if you can cancel adjacent feedbacks, errors don't propagate.

## Weak Key Derivation

**When**: The encryption key is derived from a small keyspace
(e.g., 4-digit PIN, short password, timestamp).

**How**: Brute-force the key derivation input, derive the key,
attempt decryption, check for valid plaintext.

```python
from Crypto.Cipher import AES
import hashlib

for pin in range(10000):
    key = hashlib.sha256(str(pin).encode()).digest()[:16]
    cipher = AES.new(key, AES.MODE_CBC, iv=iv)
    pt = cipher.decrypt(ct)
    if pt[-1] == pt[-1] and all(b == pt[-1] for b in pt[-pt[-1]:]):
        print(f"PIN: {pin}, plaintext: {pt}")
        break
```
