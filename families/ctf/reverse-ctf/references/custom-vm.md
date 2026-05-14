# Custom VM Reversing

## Identification

A custom VM typically has:
- **Dispatch loop**: `while(running) { opcode = fetch(); switch(opcode) {...} }`
- **Opcode table**: Array of function pointers or switch cases.
- **Virtual registers**: Array or struct simulating CPU registers.
- **Program counter**: Index into a bytecode array.
- **Virtual stack**: Separate stack for VM operations.
- **Bytecode segment**: Data section containing the VM program.

### Common Indicators

- Large switch statement with many cases (opcodes)
- Array indexed by a byte value (dispatch table)
- Loop that reads from a byte array and dispatches
- Small struct with fields like `pc`, `sp`, `regs[]`
- Data section with non-obvious byte patterns (bytecode)

## Analysis Workflow

### Step 1: Identify VM Components

1. Find the main loop (largest function, or function with big switch).
2. Identify the program counter (incremented each iteration).
3. Find the bytecode buffer (read source for PC).
4. Map out virtual registers and stack.

### Step 2: Build Opcode Map

For each switch case or dispatch entry:

```
case 0x01: regs[arg1] = regs[arg2] + regs[arg3]  → ADD
case 0x02: regs[arg1] = regs[arg2] - regs[arg3]  → SUB
case 0x03: regs[arg1] = mem[regs[arg2]]            → LOAD
case 0x04: mem[regs[arg1]] = regs[arg2]            → STORE
case 0x05: if (regs[arg1]) pc = arg2               → JNZ
case 0x06: push regs[arg1]                          → PUSH
case 0x07: regs[arg1] = pop()                       → POP
case 0x08: regs[arg1] = arg2                        → MOVI (immediate)
case 0xFF: running = false                           → HALT
```

### Step 3: Write a Disassembler

```python
opcodes = {
    0x01: ("ADD",  "rrr"),   # 3 register args
    0x02: ("SUB",  "rrr"),
    0x03: ("LOAD", "rr"),
    0x04: ("STORE","rr"),
    0x05: ("JNZ",  "ri"),    # register + immediate
    0x06: ("PUSH", "r"),
    0x07: ("POP",  "r"),
    0x08: ("MOVI", "ri"),
    0xFF: ("HALT", ""),
}

def disassemble(bytecode):
    pc = 0
    while pc < len(bytecode):
        op = bytecode[pc]
        name, fmt = opcodes.get(op, ("UNK", ""))
        pc += 1
        args = []
        for f in fmt:
            if f == 'r':
                args.append(f"r{bytecode[pc]}")
                pc += 1
            elif f == 'i':
                val = int.from_bytes(bytecode[pc:pc+2], 'little')
                args.append(f"0x{val:x}")
                pc += 2
        print(f"{pc:04x}: {name} {', '.join(args)}")
```

### Step 4: Analyze the VM Program

With the disassembly:
1. Identify input reading (which opcode reads stdin).
2. Trace the validation logic.
3. Extract constraints on the input.
4. Build a solver (Z3, manual).

## Common VM Patterns

| Pattern | Description |
|---|---|
| Stack machine | Operations use stack (push/pop) instead of registers |
| Register machine | Fixed number of virtual registers |
| Harvard architecture | Separate code and data memory |
| Self-modifying | VM program modifies its own bytecode |
| Multi-threaded VM | Multiple VMs running in parallel with shared memory |
| Nested VM | VM inside a VM (rare, high difficulty) |

## Automated Approaches

### Symbolic Execution

```python
# Use angr on the VM binary directly
# angr will symbolically execute through the dispatcher
# This works for simple VMs but path explosion is a risk

import angr
proj = angr.Project('./vm_binary', auto_load_libs=False)
state = proj.factory.entry_state()
# Constrain stdin to printable ASCII
simgr = proj.factory.simgr(state)
simgr.explore(find=success_addr, avoid=fail_addr)
```

### Lifting to IR

For complex VMs: extract the bytecode, disassemble, then translate
to a higher-level representation (Python, C, Z3 constraints) for
analysis.

## Bytecode Extraction

If the bytecode is embedded in the binary:

```bash
# Find the bytecode section
objdump -s -j .rodata binary | head -50
# Or in IDA: look for large data arrays referenced by the VM loop

# Extract with dd or Python
python3 -c "
with open('binary', 'rb') as f:
    f.seek(0xOFFSET)
    print(f.read(SIZE).hex())
"
```
