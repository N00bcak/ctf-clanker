# IDA & Ghidra Scripting

Automation is essential for challenges with obfuscation, encrypted strings, large binaries, or repetitive analysis patterns.

## IDAPython Quick Reference

### Reading
```python
import idautils, idc, ida_bytes

# Get byte/word/dword/qword at address
val = ida_bytes.get_byte(addr)
val = ida_bytes.get_dword(addr)
val = ida_bytes.get_qword(addr)

# Read N bytes
data = ida_bytes.get_bytes(addr, size)

# Get current function
func = idaapi.get_func(here())
print(f"Function: {idc.get_func_name(func.start_ea)} @ {hex(func.start_ea)}")

# Iterate all functions
for func_ea in idautils.Functions():
    name = idc.get_func_name(func_ea)
    print(f"{hex(func_ea)}: {name}")

# Get cross-references to an address
for xref in idautils.XrefsTo(addr):
    print(f"  xref from {hex(xref.frm)}")

# Get cross-references from an address
for xref in idautils.XrefsFrom(addr):
    print(f"  xref to {hex(xref.to)}")
```

### Writing / Patching
```python
# Patch bytes
ida_bytes.patch_byte(addr, 0x90)        # NOP
ida_bytes.patch_bytes(addr, b'\x90' * 5)

# Rename address
idc.set_name(addr, "my_function")

# Add comment
idc.set_cmt(addr, "decrypted string", 0)

# Create function
idc.add_func(start_addr)
```

### String Decryption Automation
```python
# Common pattern: find all calls to decrypt_string, extract arguments, decrypt
for xref in idautils.XrefsTo(decrypt_func_addr):
    # Read the argument (e.g., pointer in RDI before the call)
    # This depends on calling convention — look for the mov rdi, <addr> before the call
    call_addr = xref.frm
    # Walk backwards to find the argument setup
    prev = idc.prev_head(call_addr)
    if idc.print_insn_mnem(prev) == 'lea' and idc.get_operand_value(prev, 0) == 7:  # RDI
        str_addr = idc.get_operand_value(prev, 1)
        encrypted = ida_bytes.get_bytes(str_addr, 50)  # read encrypted string
        decrypted = decrypt(encrypted)                    # your decrypt function
        idc.set_cmt(call_addr, f'"{decrypted}"', 0)
```

### FLIRT Signatures
```python
# Apply FLIRT signatures to identify library functions in stripped binaries
# File → Load file → FLIRT signature file
# Or: Alt+F7 → select .sig file
# Source: https://github.com/push0ebp/sig-database
```

## Ghidra Scripting (Java/Python)

### Ghidra Python (via Script Manager)
```python
# File → Script Manager → New → Python
from ghidra.program.model.symbol import SourceType

# Get current program
program = currentProgram
listing = program.getListing()
fm = program.getFunctionManager()

# Iterate all functions
for func in fm.getFunctions(True):
    print(f"{func.getEntryPoint()}: {func.getName()}")

# Get bytes at address
addr = toAddr(0x401000)
data = getBytes(addr, 16)

# Rename function
func = getFunctionAt(toAddr(0x401000))
func.setName("decoded_main", SourceType.USER_DEFINED)

# Add comment
setEOLComment(toAddr(0x401000), "flag check starts here")

# Get cross-references
from ghidra.program.model.symbol import RefType
ref_mgr = program.getReferenceManager()
refs = ref_mgr.getReferencesTo(toAddr(0x401000))
for ref in refs:
    print(f"  xref from {ref.getFromAddress()}")
```

### Ghidra Headless Analysis
```bash
# Run Ghidra analysis without GUI (batch processing)
analyzeHeadless /path/to/project ProjectName -import binary \
  -postScript my_script.py -scriptPath /path/to/scripts
# Useful for: automated analysis, CI/CD, batch processing
```

## FindCrypt / Crypto Identification
```python
# IDA: Plugins → FindCrypt (searches for known crypto constants)
# Ghidra: install FindCrypt script from Ghidra Script Manager
# Identifies: AES S-box, SHA constants, MD5 init, CRC tables, DES permutations

# Manual: search for known constant values
# AES S-box starts with: 0x63, 0x7C, 0x77, 0x7B
# SHA-256 starts with: 0x6A09E667
# See compiler-artifacts.md for full constant table
```

## Entropy Analysis
```bash
# High entropy = encrypted/compressed/random data
binwalk -E binary                       # entropy graph
rabin2 -S binary | column -t            # section sizes (compare .text vs .data)
# Sections with entropy > 7.0 (out of 8) are likely encrypted/compressed
```
```python
# Python entropy calculation
import math
from collections import Counter
def entropy(data):
    freq = Counter(data)
    return -sum(f/len(data) * math.log2(f/len(data)) for f in freq.values())
# Normal code: entropy ≈ 5-6. Encrypted: ≈ 7.5-8.0. Compressed: ≈ 7.0-7.5.
```

## Common Automation Tasks
| Task | Approach |
|---|---|
| Decrypt all strings | Hook decrypt function, extract args, apply comments |
| Resolve indirect calls | Trace execution, log targets, add xrefs |
| Deobfuscate CFG flattening | Identify dispatcher variable, trace values, rebuild CFG |
| Annotate syscalls | Match syscall numbers to names from header |
| Batch rename functions | Pattern-match on function body (e.g., all functions calling printf) |
| Extract embedded data | Find high-entropy blobs, carve and save |
