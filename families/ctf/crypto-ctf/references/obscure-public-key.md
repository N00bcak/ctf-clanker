# Obscure Public-Key Cryptosystems

Cryptosystems that appear in CTF challenges but are less common than RSA/ECC. Each has a specific structural weakness exploitable in CTF settings.

## Schmidt-Samoa
**Structure**: n = p²·q. Encrypt: c = m^n mod n. Decrypt: m = c^d mod p·q where d = n⁻¹ mod lcm(p−1, q−1).
**Attack**: Factor n by finding p. Since n = p²·q, p = gcd(n, n mod p²) or trial-divide small factors. If p is small, ECM finds it fast. Once p is known, q = n / p².
```python
# IN: n (= p²·q), c  OUT: m
from sympy import factorint
factors = factorint(n)  # or use ECM / yafu
p, q = list(factors.keys())  # p appears with exponent 2
assert p^2 * q == n or p * q^2 == n
# Ensure p is the squared factor
if factors[p] == 2: pq = p * q
else: p, q = q, p; pq = p * q
d = pow(n, -1, (p-1)*(q-1) // gcd(p-1, q-1))
m = pow(c, d, pq)
from Crypto.Util.number import long_to_bytes
print(long_to_bytes(m))
```

## Okamoto-Uchiyama
**Structure**: n = p²·q. Public key: (n, g, h) where g has order p mod p², h = g^n mod n. Encrypt: c = g^m · h^r mod n. Decrypt uses the L function: L(x) = (x − 1) / p.
**Attack**: If p is discoverable (small, smooth p−1, etc.), compute L(g^(p−1) mod p²) and L(c^(p−1) mod p²), then m = L(c^(p−1)) / L(g^(p−1)) mod p.
```python
# IN: n, g, h, c, p (factored)  OUT: m
q = n // (p * p)
assert p * p * q == n
gp = pow(g, p - 1, p * p)
cp = pow(c, p - 1, p * p)
L = lambda x: (x - 1) // p
m = (L(cp) * pow(L(gp), -1, p)) % p
print(long_to_bytes(m))
```

## Paillier
**Structure**: n = p·q. Public key: (n, g) where g ∈ Z*_{n²}. Encrypt: c = g^m · r^n mod n². Decrypt: m = L(c^λ mod n²) / L(g^λ mod n²) mod n, where λ = lcm(p−1, q−1), L(x) = (x−1)/n.
**Homomorphic**: E(m₁) · E(m₂) mod n² = E(m₁ + m₂).
**Attack**: Factor n → compute λ → decrypt. Or exploit the additive homomorphism.
```python
# IN: n, g, c, p, q  OUT: m
lam = (p - 1) * (q - 1) // gcd(p - 1, q - 1)
n2 = n * n
L = lambda x: (x - 1) // n
m = (L(pow(c, lam, n2)) * pow(L(pow(g, lam, n2)), -1, n)) % n
print(long_to_bytes(m))
```
```python
# Homomorphic property:
# E(m1) * E(m2) mod n² = E(m1 + m2 mod n)
# E(m1)^k mod n² = E(k * m1 mod n)
# Exploit: if oracle encrypts attacker-chosen m and returns c,
# multiply c by a known encryption to shift the plaintext
```

## Goldwasser-Micali
**Structure**: n = p·q. Public key: (n, x) where x is a non-residue mod both p and q. Encrypt bit b: c = x^b · r² mod n. Decrypt: b = 0 if c is QR mod p (and q), else b = 1.
**Attack**: Each ciphertext encrypts a single bit. Factor n → compute Jacobi symbol of each c mod p to recover each bit.
```python
# IN: n, ciphertexts (list of ints), p, q  OUT: plaintext bits
bits = ''
for c in ciphertexts:
    # Quadratic residue mod p? (Euler criterion)
    if pow(c, (p - 1) // 2, p) == 1:
        bits += '0'
    else:
        bits += '1'
m = int(bits, 2)
print(long_to_bytes(m))
```

## Naccache-Stern
**Structure**: n = p·q. Uses a set of small primes σ = {p₁, ..., pₖ}. Public key includes σ and g (generator). Encrypt: c = g^m mod n using product of σ-primes. Decrypt via discrete log modulo each small prime.
**Attack**: Factor n → for each small prime pᵢ in σ, compute the discrete log of c^((p−1)/pᵢ) to recover m mod pᵢ, then CRT.

## Benaloh (Dense Probabilistic)
**Structure**: n = p·q where r | (p−1) and gcd(r, (p−1)/r) = 1. Public key: (n, y, r). Encrypt: c = y^m · u^r mod n. Decrypt: compute m via r-th residuosity.
**Attack**: Factor n → compute discrete log in the subgroup of order r.

## Merkle-Hellman Knapsack
**Structure**: Superincreasing sequence {a₁, ..., aₙ} is the private key. Public key is a permuted, modularly-transformed version. Encrypt: pick bits b₁...bₙ, compute c = Σ bᵢ · pubᵢ.
**Attack**: LLL lattice reduction on the public key recovers the plaintext bits.
```python
# SageMath — IN: pub (list of public key values), c (ciphertext)  OUT: bits
n = len(pub)
M = matrix(ZZ, n + 1, n + 1)
for i in range(n):
    M[i, i] = 1
    M[i, n] = pub[i]
M[n, n] = -c

L = M.LLL()
for row in L:
    if all(b in (0, 1) for b in row[:n]) and row[n] == 0:
        bits = list(row[:n])
        # Verify
        assert sum(b * p for b, p in zip(bits, pub)) == c
        print(''.join(str(b) for b in bits))
        break
```
**Trap**: Works best when density d = n / log₂(max(pubᵢ)) < 0.9408 (low-density). High-density knapsacks need CJLOSS or other techniques.

## Identification Guide
| Clue in Challenge | Likely Cryptosystem |
|---|---|
| n = p²·q, encrypt as m^n | Schmidt-Samoa |
| n = p²·q, L function, g^m · h^r | Okamoto-Uchiyama |
| n², g^m · r^n mod n², additive homomorphic | Paillier |
| Encrypts single bits, quadratic residuosity | Goldwasser-Micali |
| Small prime set σ, residuosity mod σ-primes | Naccache-Stern |
| Superincreasing sequence, subset sum | Merkle-Hellman knapsack |
| Custom Feistel with round function F | See `feistel-analysis.md` |
