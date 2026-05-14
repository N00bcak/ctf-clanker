# Binary Patching & Diffing

## Patch Recipes
| Goal | x86 Bytes | How |
|---|---|---|
| NOP instruction | `90` | Overwrite N bytes with `\x90` × N |
| `je` → `jne` | `74` → `75` | Flip condition (1-byte displacement) |
| `jne` → `je` | `75` → `74` | Flip condition |
| Near `je` → `jne` | `0F 84` → `0F 85` | 4-byte displacement variant |
| Force unconditional jump | `74 XX` → `EB XX` | `je` rel8 → `jmp` rel8 |
| Return immediately | `B8 XX XX XX XX C3` | `mov eax, VALUE; ret` |

## Python Patcher
```python
# IN: binary_path, offset, patch_bytes  OUT: patched_binary_path
with open('binary', 'rb') as f: data = bytearray(f.read())
data[offset:offset+len(patch)] = patch  # e.g., b'\x90' * 6
with open('binary_patched', 'wb') as f: f.write(data)
```

## radare2
```bash
r2 -w binary                   # open writable
s 0x1234; wa "nop;nop;nop"     # write assembly
wx 9090909090                  # write hex bytes
wa "jmp 0x5678"                # write jump
```

## IDA / Ghidra
- IDA: Edit → Patch program → Change byte / Assemble → Apply patches to input file.
- Ghidra: Right-click instruction → Patch Instruction.

## Binary Diffing
```bash
radiff2 binary_v1 binary_v2               # byte-level diff
radiff2 -g main binary_v1 binary_v2       # function graph diff
```
**Tools**: BinDiff (IDA plugin), Diaphora (IDA, free), `xxd binary | diff`.

## Common CTF Patches
| Scenario | Patch |
|---|---|
| Anti-debug check | NOP the check or flip its conditional |
| Serial/license validation | Force the "valid" branch |
| Sleep/delay | NOP the call or zero the argument |
| Self-integrity hash | NOP the comparison or update the expected hash |
| Network phone-home | NOP the call or redirect DNS |
