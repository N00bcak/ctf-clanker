# Triage Checklist

## Artifact Identification Commands

Run on every provided file before classifying:

```
file <file>                        # MIME type and format
strings <file> | head -80          # printable strings
xxd <file> | head -30              # hex header
binwalk <file>                     # embedded files and offsets
exiftool <file>                    # metadata
```

If an archive: extract first, then inspect contents individually.

## Category Signal Table

| Observation | Primary Category | Confidence |
|---|---|---|
| ELF/PE binary + libc/Dockerfile/remote endpoint | `pwn-ctf` | high |
| ELF/PE binary without exploitation context | `reverse-ctf` | high |
| APK, WASM, custom VM bytecode, .NET, packed binary | `reverse-ctf` | high |
| Python script with crypto imports, .pem, large integers | `crypto-ctf` | high |
| Challenge text mentions RSA, AES, cipher, modulus, exponent | `crypto-ctf` | medium |
| URL, HTTP service, HTML/JS/CSS, web framework | `web-ctf` | high |
| PCAP, .raw, .E01, .vmem, memory dump | `forensics-ctf` | high |
| Image with "hidden"/"stego" hint or unusual file size | `forensics-ctf` | medium |
| Audio file with "something hidden" hint | `forensics-ctf` | medium |
| "pyjail", "escape", restricted shell/sandbox | `misc-ctf` | high |
| Esoteric encoding, QR code, unusual character set | `misc-ctf` | medium |
| OSINT, geolocation, social media investigation | `misc-ctf` | high |

## Disambiguation Rules

When multiple categories are plausible:

1. Web app serving a binary → `web-ctf` (the web app is the attack surface).
2. Crypto challenge with a network oracle → `crypto-ctf` (crypto is the target).
3. Binary needing reverse engineering before exploitation → `reverse-ctf`.
4. Forensic artifact containing encrypted data → `forensics-ctf`.
5. "Crypto" tag on challenge shipping a binary → likely `reverse-ctf` (custom cipher).
6. If genuinely equal → pick the category producing the most useful first-pass evidence.

## Common Traps

- Challenge descriptions may be misleading. Trust artifacts over descriptions.
- "Misc" challenges sometimes hide a specific category under encoding layers.
- A zip/tar containing a single file → inspect the inner file, not the archive.
- A "crypto" tag on a challenge that ships a binary often means reverse the algorithm.
- Multiple files may belong to different categories — triage each independently.
- Point values sometimes correlate with category: low-point misc can be encoding,
  high-point misc can be multi-stage spanning several categories.
