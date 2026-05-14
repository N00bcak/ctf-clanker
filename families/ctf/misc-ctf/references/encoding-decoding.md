# Encoding & Decoding

## Identification
| Pattern | Encoding |
|---|---|
| `[A-Za-z0-9+/=]`, len%4==0 | Base64 |
| `[A-Z2-7=]`, len%8==0 | Base32 |
| `[0-9a-fA-F]`, even length | Hex |
| `%XX` sequences | URL encoding |
| `&#NNN;` / `&#xHH;` | HTML entities |
| `[01]` groups of 8 | Binary ASCII |
| `<~ ... ~>` | Base85/Ascii85 |
| Shifted letters | Caesar/ROT-N |

## Decoding
```bash
echo "$DATA" | base64 -d          # Base64
echo "$DATA" | base32 -d          # Base32
echo "$DATA" | xxd -r -p          # Hex
python3 -c "import urllib.parse; print(urllib.parse.unquote('$DATA'))"   # URL
python3 -c "print(bytes.fromhex('$DATA').decode())"                     # Hex (Python)
```

## Multi-Layer
Decode outermost layer → identify next → repeat. **CyberChef "Magic" recipe** auto-detects and chains decodings.

## Special Encodings
**Morse**: `.` = dit, `-` = dah. E=`.`, T=`-`, A=`.-`, N=`-.`, I=`..`, M=`--`.
**Braille**: 6-dot cell patterns → letters.
**Semaphore**: flag positions → letters.
**NATO**: Alpha Bravo Charlie Delta Echo Foxtrot ...
**Tap Code**: row taps, pause, column taps (5×5 Polybius, K omitted).

## Number Conversions
```python
hex(255)         # '0xff'     | int('ff', 16)      # 255
bin(255)         # '0b...'    | int('11111111', 2)  # 255
oct(255)         # '0o377'    | int('377', 8)       # 255
chr(65)          # 'A'        | ord('A')            # 65
```

## Tools
`CyberChef`, `dcode.fr` (identification + solving), `base64`/`base32`/`xxd` (CLI).
