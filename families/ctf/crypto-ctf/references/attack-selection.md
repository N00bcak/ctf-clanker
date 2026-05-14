# Attack Selection

Use this after filling the mechanism-property ledger. Pick one primary
attack and one bounded fallback, then open only the detailed reference
for that family.

## RSA

| Signal | Try |
|---|---|
| Small e, small message | Integer e-th root |
| Same plaintext, multiple moduli | Hastad broadcast or batch GCD |
| Related messages or known prefix/suffix | Franklin-Reiter or Coppersmith |
| Small/special factors, close p and q, shared factors | Factoring path |
| Known partial p, q, or d | Coppersmith partial key recovery |
| Small d or unusual e/d relation | Wiener or Boneh-Durfee |
| Padding or LSB oracle | Oracle attack |

## Symmetric And Classical

| Signal | Try |
|---|---|
| Repeated ciphertext blocks | ECB block analysis |
| CBC padding validity leak | Padding oracle |
| CBC known plaintext and controllable target | Bit flip |
| CTR/stream nonce or keystream reuse | XOR ciphertexts, recover keystream |
| Weak password/key derivation | Constrained brute force |
| Caesar, substitution, Vigenere, transposition | Classical frequency/key-length analysis |

## PRNG And Linear Systems

| Signal | Try |
|---|---|
| MT19937 outputs | Untemper and clone state |
| LCG-like recurrence | Recover modulus/multiplier/increment |
| Time-based seed | Brute-force seed window |
| LFSR or linear recurrence over GF(2) | Berlekamp-Massey or correlation attack |
| Truncated/biased outputs | Lattice or constraint solving |

## ECC And Signatures

| Signal | Try |
|---|---|
| Unvalidated points | Invalid curve or small subgroup |
| Reused ECDSA/DSA nonce | Recover private key |
| Biased nonce | Hidden number/lattice attack |
| Singular or anomalous curve | Group mapping or Smart attack |
| Small embedding degree | MOV transfer |
| Signature equation is custom | Algebraic forgery or malleability check |

## Other Mechanisms

| Signal | Try |
|---|---|
| Length-extension-prone hash MAC | Length extension |
| MAC compare leak | Timing attack |
| LWE/NTRU/knapsack-like public key | Lattice attack |
| Secret shares with weak threshold/coefficients | Interpolate or solve constraints |
| Custom Feistel/SPN with few rounds | Differential, slide, or meet-in-the-middle |
| Unknown public-key scheme | Identify algebraic structure, then map to known family |
