---
name: reverse-ctf
description: Recover logic and constraints from CTF binaries, bytecode, VMs, APKs, WASM, or obfuscated programs.
---

# Reverse CTF

## Purpose

Analyze reverse engineering challenges and recover the logic needed to reach
a flag or solve condition. This covers static analysis, dynamic analysis,
constraint reconstruction, and solver production.

## Use When

- The challenge centers on binaries, bytecode, custom VMs, APKs, WASM,
  packed code, or obfuscation.
- Static or dynamic analysis is needed to understand hidden validation or
  transformation logic.
- The objective is to recover constraints, keys, or algorithms — not to
  exploit memory corruption.

## Do Not Use

- Memory corruption exploitation is the goal — use `pwn-ctf`.
- Network traffic or disk images are the primary artifact — use `forensics-ctf`.
- The challenge is a web application — use `web-ctf`.
- The category is unknown — use `ctf-triage` first.
- Do not spawn, request, or rely on subagents.

## Needs

- Challenge binary, bytecode, or source.
- Runtime and platform details if known (architecture, OS, language).
- Flag format or success condition.
- Tooling constraints if specified.

## Returns

- Recovered validation or transformation logic.
- Constraint set suitable for solving (SAT, Z3, manual).
- Solver script when applicable.
- Flag or explicit blocker with evidence.

## Done Conditions

- The validation or transformation path is fully traced.
- A solver is produced, or the flag is recovered directly.
- If blocked, the blocker is explicit with evidence and next recovery step.

## Persistence And Yield

Useful progress means recovered logic, identified validation structure,
bypassed obfuscation layer, narrowed constraint set, or new understanding
of the binary's control flow.

Before yielding:

- Try the primary analysis path (static → dynamic → constraint extraction).
- Try one distinct bounded alternative (different tool, different entry point,
  different analysis strategy).
- Check whether missing information is discoverable (strings, debug symbols,
  dynamic tracing).
- Confirm the next action would repeat prior work, require unsafe guessing,
  or leave this skill's boundary.

Do not yield merely because the binary is obfuscated, stripped, or large.

When yielding, return the analysis performed, logic recovered so far, specific
blocker, why more work would repeat, and the next recovery step.

## Methodology

### Evidence-First Workflow

Start from the real binary, not the challenge description. Run concrete
inspection commands before forming hypotheses.

```
file <binary>                          # format and architecture
readelf -h <binary>                    # ELF header details
strings <binary> | grep -iE 'flag|pass|correct|wrong|key'
xxd <binary> | head -30                # hex header
objdump -d <binary> | head -100        # disassembly preview
```

### Step 1: Identify Format and Architecture

Determine: ELF vs PE vs Mach-O vs bytecode vs custom format. Note
architecture (x86, x64, ARM, MIPS), endianness, and whether stripped.

For non-native formats: APK → jadx/apktool, WASM → wasm-decompile,
.NET → dnSpy/ILSpy, Python bytecode → uncompyle6/pycdc.

### Step 2: Static Analysis

Load in disassembler (IDA, Ghidra, or radare2). Focus on:

1. **Entry point and main flow**: follow from `_start` or `main`.
2. **Input consumption**: where is user input read? What size/format?
3. **Validation chain**: what operations transform or check the input?
4. **String references**: cross-reference interesting strings.
5. **Crypto constants**: S-boxes, round constants, known magic numbers.
6. **Custom VM detection**: dispatch loop, opcode table, bytecode segment.

### Step 3: Identify Key Patterns

- **Linear validation**: input checked byte-by-byte or block-by-block.
- **Transformation then compare**: input transformed, result compared to constant.
- **Custom VM**: input is bytecode or processed by an interpreter loop.
- **Anti-debug**: ptrace checks, timing checks, signal handlers, self-modification.
- **Obfuscation**: control flow flattening, opaque predicates, string encryption.

For anti-debug: identify the check, patch or bypass (conditional jump, LD_PRELOAD,
Frida hook). For obfuscation: focus on data flow rather than control flow.

### Step 4: Dynamic Analysis

When static analysis is insufficient, use dynamic tools:

- **GDB/lldb**: set breakpoints at validation, inspect registers and memory.
- **Frida**: hook functions to log arguments and return values.
- **strace/ltrace**: trace syscalls and library calls.
- **angr**: symbolic execution to find paths to success condition.

### Step 5: Reconstruct and Solve

Build the constraint set from recovered logic. Choose solver:

- **Z3/SAT**: for constraint satisfaction over input bytes.
- **Manual**: for simple transformations (XOR, shift, lookup table).
- **angr**: for automated path exploration to success state.
- **Brute-force**: when key space is small and validation is fast.

Produce a solver script, verify it produces the flag, and document
the approach.

### Apple Silicon Notes

- ELF and PE binaries cannot run natively on macOS ARM.
- Use IDA or Ghidra for static analysis of foreign binaries — this works fine.
- For dynamic analysis, ask the user for a Debian VM IP and work over SSH.
- Rosetta handles x86 macOS Mach-O only, not ELF.
- Identify architecture early with `file` to avoid wasted time.

## Pivot Rules

- If exploitation is needed after reversing, hand off to `pwn-ctf` with the
  recovered logic and vulnerability description.
- If the binary implements a known cryptosystem with a parameter weakness,
  hand off to `crypto-ctf` with the extracted parameters.
- If the challenge is actually a forensic artifact packaged as a binary,
  hand off to `forensics-ctf`.

## Reference

- `references/static-analysis.md` — IDA, Ghidra, radare2, objdump workflow
- `references/dynamic-analysis.md` — GDB, Frida, angr, strace, Unicorn
- `references/anti-debug-and-obfuscation.md` — ptrace, timing, CFG flattening, packing
- `references/custom-vm.md` — dispatch identification, bytecode disassembly
- `references/language-specific.md` — Python, Go, Rust, WASM, .NET, APK, Verilog
- `references/constraint-solving.md` — Z3, angr symbolic, SAT, brute-force, instruction counting
- `references/firmware-and-embedded.md` — firmware extraction, emulation, IoT, UART/JTAG
- `references/binary-patching.md` — NOP, conditional flip, diffing, ELF manipulation
- `references/compiler-artifacts.md` — calling conventions, optimization patterns, crypto constants
- `references/cpp-reversing.md` — vtables, RTTI, name demangling, STL container layouts
- `references/windows-pe.md` — PE headers, imports/exports, resources, x64dbg, DLLs
- `references/anti-disassembly.md` — junk bytes, overlapping instructions, exception-based flow
- `references/ida-ghidra-scripting.md` — IDAPython, Ghidra scripts, FindCrypt, FLIRT, entropy
- `references/binary-formats.md` — ELF/PE internals, GOT/PLT, sections, polyglot, stripped ID
- `references/protocol-reversing.md` — network protocol RE, TLV parsing, replay, custom dissectors
