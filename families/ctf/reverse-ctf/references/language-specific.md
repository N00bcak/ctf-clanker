# Language-Specific Reversing

## Python Bytecode (.pyc)

### Decompilation

```bash
uncompyle6 program.pyc                 # Python 2.7-3.8
pycdc program.pyc                      # Python 3.9+ (decompyle3)
```

### Manual Analysis

```python
import dis, marshal

with open('program.pyc', 'rb') as f:
    magic = f.read(4)    # magic number (identifies Python version)
    flags = f.read(4)    # flags (3.7+)
    timestamp = f.read(4)
    size = f.read(4)     # source size (3.3+)
    code = marshal.load(f)

dis.dis(code)            # disassemble bytecode
```

### Remapped Opcodes

Some challenges remap bytecode opcodes. Recover the mapping by:
1. Compiling a known script with the custom Python
2. Comparing expected vs actual bytecodes
3. Building the opcode translation table

## Go Binaries

**Characteristics**: Large, statically linked, many symbols (unless
stripped), goroutine-based, unusual calling convention.

### Symbol Recovery (Stripped)

```bash
# GoReSym recovers function names from Go metadata
GoReSym -t -d -p ./go_binary

# Ghidra: install go_parser script
# IDA: use IDAGolangHelper
```

### Key Structures

- `runtime.main` → actual `main.main`
- String literals stored as `{ptr, len}` pairs (no null terminator)
- Interfaces: `{type_ptr, data_ptr}`
- Slices: `{ptr, len, cap}`

### Debugging

```bash
dlv exec ./go_binary                   # Delve debugger
dlv exec ./go_binary -- arg1 arg2      # with arguments
```

## Rust Binaries

**Characteristics**: Large (static linking common), many panic
strings, complex generic type names, Option/Result enums.

### Symbol Demangling

```bash
rustfilt '_ZN4core3fmt...'             # demangle Rust symbols
c++filt -n '_ZN4core3fmt...'           # also works for many cases
```

### Key Patterns

- Panic strings often reveal function names and file paths
- `unwrap()` calls → `panic` → useful cross-references
- `match` statements compile to jump tables
- `Result<T, E>` → check patterns for Ok/Err handling

## .NET (C# / VB.NET)

### Decompilation

```bash
# GUI tools
dnSpy                                  # decompile + debug + edit
ILSpy                                  # decompile
dotPeek                                # JetBrains decompiler

# CLI
ilspycmd program.exe -o output/        # ILSpy command line
```

### IL Inspection

```bash
ildasm program.exe                     # MSIL disassembler
monodis program.exe                    # Mono disassembler
```

.NET binaries contain full metadata — class names, method names,
string constants. Decompilation is usually near-perfect.

## Android APK

```bash
# Java decompilation
jadx -d output/ app.apk               # decompile to Java
apktool d app.apk                      # decode resources + smali

# Native libraries
# Check lib/ directory for .so files → analyze with IDA/Ghidra

# Flutter/Dart
# Look for libapp.so → use reFlutter or Doldrums
```

### Key Locations

- `AndroidManifest.xml` — permissions, activities, services
- `classes.dex` — Java bytecode
- `lib/<arch>/` — native libraries
- `assets/` — additional data files
- `res/` — resources (strings, layouts)

## WASM (WebAssembly)

```bash
wasm-decompile program.wasm            # high-level decompilation
wasm2wat program.wasm                  # text format (WAT)
wasm2c program.wasm -o program.c       # convert to C
```

### Browser DevTools

Load the WASM module in a browser, use DevTools:
- Sources tab shows WASM text format
- Set breakpoints on WASM functions
- Inspect memory (Memory tab)

## Java (.class / .jar)

```bash
javap -c -p Class.class                # disassemble with private members
cfr Class.class                        # decompile to Java
procyon Class.class                    # alternative decompiler
jd-gui app.jar                         # GUI decompiler for JARs
```

## Compiled JavaScript (V8 Bytecode)

For `jsc` files (compiled V8 bytecode):
- Use `node --print-bytecode` to dump bytecode format
- `bytenode` to decompile if version matches

## Verilog / Hardware

```bash
# Simulate
iverilog -o sim design.v testbench.v
vvp sim
gtkwave dump.vcd                       # view waveforms

# Synthesize
yosys -p "read_verilog design.v; synth; show"
```

For FPGA challenges: extract the logic, understand the
transformation, then compute the inverse.
