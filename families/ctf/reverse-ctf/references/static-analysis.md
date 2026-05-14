# Static Analysis

## Initial Inspection

```bash
file <binary>                          # format, architecture, linkage
readelf -h <binary>                    # ELF header (entry point, arch)
readelf -S <binary>                    # section table
readelf -s <binary>                    # symbol table (if not stripped)
readelf -d <binary>                    # dynamic section (libraries)
objdump -d <binary> | head -200        # disassembly preview
strings -a <binary> | sort -u          # all printable strings
strings -el <binary>                   # wide strings (UTF-16LE)
nm <binary>                            # symbol list (if not stripped)
```

## Tool Selection

| Format | Primary | Fallback |
|---|---|---|
| ELF x86/x64 | IDA Pro, Ghidra | radare2, objdump |
| PE x86/x64 | IDA Pro, Ghidra | x64dbg, PE-bear |
| Mach-O | IDA Pro, Ghidra | Hopper |
| APK | jadx (Java), apktool | JEB, Bytecode Viewer |
| WASM | wasm-decompile, wasm2c | Chrome DevTools |
| .NET | dnSpy, ILSpy | dotPeek |
| Python .pyc | uncompyle6, pycdc | `dis` module, `marshal` |
| Go | IDA + GoReSym | Ghidra + go_parser |
| Rust | IDA, Ghidra | grep for panic strings |
| Verilog/HW | Yosys, iverilog | manual analysis |

## Disassembler Workflow

### IDA Pro

1. Load binary → auto-analysis completes
2. Go to `main` (or entry point) — `G` to jump by address
3. Rename functions/variables for clarity — `N`
4. Cross-reference strings — View → Open subviews → Strings
5. Follow function calls — double-click or `Enter`
6. Create structs for complex data — View → Local Types
7. Decompile — `F5` (Hex-Rays)
8. Apply signatures — File → Load file → FLIRT

### Ghidra

1. Import binary → auto-analyze
2. Symbol Tree → Functions → main
3. Decompile window shows C pseudocode
4. Define data types in Data Type Manager
5. Right-click → References → Find references to
6. Edit → Tool Options → Decompiler for display settings

### radare2

```bash
r2 -A <binary>                         # open with analysis
afl                                    # list functions
s main; pdf                            # seek to main, print disassembly
axt <addr>                             # cross-references to
axf <addr>                             # cross-references from
VV                                     # visual graph mode
iz                                     # list strings
```

## Key Analysis Targets

1. **Entry point → main flow**: trace from `_start` to `main`.
2. **Input consumption**: `scanf`, `read`, `fgets`, `recv`, `getline`.
3. **Validation logic**: `strcmp`, `memcmp`, conditional jumps.
4. **Crypto constants**: S-boxes (256-byte tables), round constants.
5. **String cross-refs**: find "correct", "wrong", "flag", "password".
6. **Import table**: what library functions are called.
7. **Function call graph**: understand program structure.

## Identifying Common Patterns

| Pattern | Indicators |
|---|---|
| Linear check (byte-by-byte) | Loop with indexed comparison, early exit |
| Transform then compare | Input transformed, result compared to constant array |
| Hash/checksum | Specific constants (e.g., MD5 init values) |
| Encryption/decryption | S-boxes, key schedule, round functions |
| Custom VM | Dispatch loop, opcode table, program counter |
| Packed/encrypted code | High entropy sections, self-modifying code |

## Apple Silicon Notes

- IDA and Ghidra work natively for static analysis of any architecture.
- `file` and `strings` work locally.
- Cannot execute ELF/PE binaries — dynamic analysis needs a VM.
