# Classical Ciphers

## Caesar / ROT-N
**When**: letters only, frequency shape preserved but shifted. ROT13: shift=13. ROT47: ASCII 33–126.
```python
# IN: ct (str)  OUT: prints all 26 shifts
for s in range(26):
    print(s, ''.join(chr((ord(c)-65+s)%26+65) if c.isalpha() else c for c in ct.upper()))
```

## Simple Substitution
**When**: letters only, skewed frequency (not shifted, not flat). | **Tool**: `quipqiup.com` solves most instances instantly.
```python
# IN: ct (str)  OUT: frequency table to compare against ETAOINSHRDLU
from collections import Counter
print(Counter(ct.upper()).most_common())
```

## Vigenere
**When**: flatter-than-substitution frequencies, repeating pattern in IC per column.
```python
# IN: ct (str, letters only)  OUT: key (str)
from collections import Counter
from math import gcd
from functools import reduce

def ic(t):
    n=len(t); f=Counter(t); return sum(v*(v-1) for v in f.values())/(n*(n-1)) if n>1 else 0

# Phase 1: key length via IC (English ≈ 0.067, random ≈ 0.038)
best_kl, best_ic = 1, 0
for kl in range(1, 30):
    avg = sum(ic(ct[i::kl]) for i in range(kl)) / kl
    if avg > best_ic: best_kl, best_ic = kl, avg

# Phase 2: per-column frequency → best shift
key = ''
for i in range(best_kl):
    col = ct[i::best_kl]
    best_s = max(range(26), key=lambda s: sum(1 for c in col if chr((ord(c)-65-s)%26+65) in 'ETAOINSHRDLU'))
    key += chr(best_s + 65)

pt = ''.join(chr((ord(c)-ord(key[i%len(key)]))%26+65) if c.isalpha() else c for i,c in enumerate(ct.upper()))
assert any(w in pt for w in ['THE','FLAG','AND'])  # sanity-check English
print(f"Key: {key}  PT: {pt}")
```

## XOR Repeating Key
**When**: binary/hex data. | **Trap**: use Hamming distance for key length, not IC.
```python
# IN: ct (bytes)  OUT: key (bytes), pt (bytes)

# Key-length via normalized Hamming distance
def hamming(a, b): return sum(bin(x^y).count('1') for x,y in zip(a,b))
scores = []
for ks in range(2, 40):
    blocks = [ct[i*ks:(i+1)*ks] for i in range(4)]
    if len(blocks[3]) < ks: continue
    d = sum(hamming(blocks[i],blocks[j])/ks for i in range(4) for j in range(i+1,4)) / 6
    scores.append((d, ks))
key_len = min(scores)[1]

# Per-byte key recovery (frequency scoring)
key = bytes(max(range(256), key=lambda k: sum(1 for b in ct[i::key_len] if 0x20<=b^k<=0x7e)) for i in range(key_len))
pt = bytes(c^key[i%len(key)] for i,c in enumerate(ct))
assert b'flag' in pt.lower() or pt[:20].isascii()
```

## Known-plaintext XOR crib
```python
# IN: ct (bytes), crib (bytes, e.g. b"flag{")  OUT: key fragment at each offset
for off in range(len(ct)-len(crib)):
    frag = bytes(c^p for c,p in zip(ct[off:], crib))
    if all(0x20<=b<=0x7e for b in frag): print(f"offset {off}: {frag}")
```

## Transposition — Rail Fence
**When**: same letter frequencies as English (rearranged, not substituted).
```python
# IN: ct (str), rails (int, try 2–10)  OUT: pt (str)
def rail_decode(ct, r):
    idx = list(range(r)) + list(range(r-2, 0, -1))
    order = sorted(range(len(ct)), key=lambda i: (idx[i%len(idx)], i))
    pt = [''] * len(ct)
    for i, c in zip(order, ct): pt[i] = c
    return ''.join(pt)
for r in range(2, 11):
    d = rail_decode(ct, r)
    if 'flag' in d.lower(): print(f"rails={r}: {d}")
```

## Affine
**When**: E(x) = (a·x + b) mod 26. | 12 valid a values × 26 b values = 312 total.
```python
# IN: ct (str)  OUT: pt for all valid (a,b)
from math import gcd
for a in range(1,26):
    if gcd(a,26)!=1: continue
    a_inv = pow(a,-1,26)
    for b in range(26):
        pt = ''.join(chr((a_inv*(ord(c)-65-b))%26+65) if c.isalpha() else c for c in ct.upper())
        if 'FLAG' in pt: print(f"a={a} b={b}: {pt}")
```

## OTP Key Reuse (Many-Time Pad)
**When**: same key XORed with multiple plaintexts → c1⊕c2 = p1⊕p2. Same as CTR nonce reuse — see `block-cipher-modes.md`. Use crib dragging.

## Tools
`dcode.fr` (identification), `quipqiup.com` (substitution), `CyberChef` (multi-tool), `xortool` (XOR analysis).
