# Mechanism-Property Ledger

Before selecting an attack, map the cryptosystem's properties. This
framework applies to any cryptographic mechanism — standard or custom.

## Ledger Template

| Property | Determine |
|---|---|
| **Algorithm** | Standard (RSA, AES, ECC) or custom? What mathematical operation? |
| **Parameters** | Key size, modulus, curve, block size, rounds, field? |
| **Key generation** | How are keys derived? Weak RNG? Small search space? Related keys? |
| **Randomness** | Nonce, IV, seed? Reused, predictable, short, time-based? |
| **Oracle access** | Encrypt, decrypt, sign, verify? How many queries? Adaptive? |
| **Malleability** | Can ciphertext be modified with predictable plaintext effect? |
| **Error behavior** | Distinct error messages? Timing differences? Padding errors? |
| **Known values** | Known plaintext, known ciphertext, partial key, public parameters? |
| **Algebraic structure** | Group, ring, field? What algebraic relationships can be exploited? |

## How to Use

1. Fill every row, even if the answer is "unknown" or "N/A".
2. Each property constrains which attacks apply — a completed ledger
   usually points to one or two attack families.
3. If the mechanism is unfamiliar, search for the exact algorithm name
   and fill the ledger from specs or papers.
4. Re-check the ledger after each failed attack — you may have missed
   a property.

## Example: RSA with Small e

| Property | Value |
|---|---|
| Algorithm | RSA |
| Parameters | n=2048 bits, e=3 |
| Key generation | Standard |
| Randomness | No padding randomness (textbook RSA) |
| Oracle access | Encryption only |
| Malleability | Yes (multiplicative) |
| Error behavior | N/A |
| Known values | Public key (n, e), ciphertext c |
| Algebraic structure | Z/nZ multiplicative group |

**Conclusion**: Small e + no padding → try direct cube root. If m^3 > n,
try Coppersmith or Hastad if multiple ciphertexts available.

## Common Property → Attack Mapping

| Property Pattern | Likely Attack Family |
|---|---|
| Small public exponent | RSA small-e attacks |
| Modulus with special structure | Factoring attacks |
| Nonce/IV reuse | Stream/CTR reuse, ECDSA nonce reuse |
| Padding oracle | CBC padding oracle, Bleichenbacher |
| Known partial key | Coppersmith partial key recovery |
| Error message differences | Padding/timing oracle |
| Multiple related ciphertexts | Related message attacks, broadcast |
| Custom/unknown algorithm | Reverse engineer, then re-apply framework |
| Time-based seed | PRNG seed brute-force |
