# Binary Format Internals

Understanding file format internals for RE challenges.

## ELF Internals

### GOT/PLT Resolution
```
First call to printf@plt:
1. PLT stub: jmp [GOT[printf]]          → GOT initially points to PLT+6
2. PLT+6: push reloc_index; jmp PLT[0]  → dynamic linker resolver
3. Resolver: looks up printf in libc, writes address to GOT[printf]
4. Subsequent calls: jmp [GOT[printf]]   → direct jump to printf in libc
```
```bash
objdump -d -j .plt binary               # PLT stubs
objdump -R binary                        # GOT relocation entries
readelf -r binary                        # relocation table
readelf --dyn-syms binary                # dynamic symbol table
```

### Section vs Segment View
```
Sections (.text, .data, .bss, .rodata) — used by linker, optional at runtime
Segments (LOAD, DYNAMIC, INTERP) — used by loader, mandatory at runtime

# Stripped binaries may have no section headers — rely on segments
readelf -l binary                        # program headers (segments)
readelf -S binary                        # section headers (may be absent)
```

### Key Sections
| Section | Contains |
|---|---|
| `.text` | Executable code |
| `.rodata` | Read-only data (strings, constants) |
| `.data` | Initialized writable data |
| `.bss` | Uninitialized data (zero-filled at load) |
| `.plt` / `.plt.got` | PLT stubs for dynamic linking |
| `.got` / `.got.plt` | Global Offset Table |
| `.init_array` / `.fini_array` | Constructor/destructor function pointers |
| `.dynamic` | Dynamic linking info |
| `.symtab` / `.dynsym` | Symbol tables |
| `.strtab` / `.dynstr` | String tables for symbols |
| `.note.gnu.build-id` | Build ID (unique binary identifier) |

## PE Internals

### Import Address Table (IAT)
```
Similar to GOT — contains resolved function addresses after loading.
Before resolution: IAT entries point to Import Name Table (hint/name).
After resolution: IAT entries contain actual function addresses.
```

### Key PE Sections
| Section | Contains |
|---|---|
| `.text` | Code |
| `.rdata` | Read-only data, import/export tables |
| `.data` | Writable data |
| `.rsrc` | Resources (icons, dialogs, embedded files) |
| `.reloc` | Relocation table (for ASLR) |
| `.edata` | Export table |
| `.idata` | Import table |
| `.tls` | Thread-local storage |

## Polyglot Files
**What**: A file that is valid in multiple formats simultaneously.
```python
# ELF + script polyglot:
# Start with ELF header that's also valid shell script
# #!/bin/sh is 23 21 2F 62 69 6E 2F 73 68
# ELF magic is 7F 45 4C 46
# These don't overlap → can't be both trivially

# PDF + ZIP polyglot:
# PDF parser reads from start (%%PDF header)
# ZIP parser reads from end (End of Central Directory)
# Put ZIP data after PDF data → valid in both formats
```
```bash
# Detect: run `file` — may report only one format
# binwalk finds embedded formats
# Check with multiple parsers
```

## Tiny ELF
**What**: Minimized ELF binaries (< 100 bytes) that are valid and execute.
```bash
# 64-byte ELF that exits:
# ELF header fields reused as code (e_entry overlaps with instructions)
# Section headers omitted (only segments needed at runtime)
# The 52-byte ELF header IS the entire binary

# Analysis: every byte serves double duty as both header field and instruction
# Use: xxd + manual disassembly, since IDA/Ghidra may choke on the overlap
xxd tiny_elf | head -5
objdump -d -b binary -m i386:x86-64 -D tiny_elf
```

## Stripped Binary Identification
```bash
file binary                              # "stripped" vs "not stripped"
readelf -s binary | wc -l                # 0 symbols = stripped
nm binary 2>&1 | grep "no symbols"       # confirm
```

### FLIRT Signatures (IDA)
IDA's Fast Library Identification and Recognition Technology matches function bodies against known library signatures.
```
File → Load file → FLIRT signature file
# Download sigs: https://github.com/push0ebp/sig-database
# Matches: libc, libstdc++, OpenSSL, zlib, etc.
# Instantly renames hundreds of library functions
```

### Ghidra Function ID
```
Analysis → One-shot → Function ID
# Similar to FLIRT — matches against known function databases
# Apply FID databases from Ghidra's default set or custom
```

### Manual Identification
```bash
# Use strings to find library version strings
strings binary | grep -iE 'openssl|glibc|libcurl|zlib'
# Use known constant patterns (see compiler-artifacts.md)
# Cross-reference with ldd output of a similar binary
```
