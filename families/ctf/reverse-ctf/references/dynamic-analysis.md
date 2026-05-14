# Dynamic Analysis

## GDB

```bash
gdb -q ./binary

# Basic commands
b main                                 # breakpoint at main
b *0xADDR                             # breakpoint at address
r                                      # run
r < input.txt                          # run with stdin
c                                      # continue
si                                     # step instruction
ni                                     # next instruction (skip calls)
finish                                 # run until current function returns

# Examination
x/20gx $rsp                           # examine 20 64-bit words at RSP
x/s 0xADDR                            # examine as string
x/20i 0xADDR                          # examine as instructions
p $rax                                 # print register
info registers                         # all registers
bt                                     # backtrace

# Memory modification
set $rax = 0x42                        # set register
set {int}0xADDR = VALUE                # write to memory
set {char[4]}0xADDR = "AAAA"           # write string

# Syscall tracing
catch syscall write                    # break on write syscall
catch signal SIGTRAP                   # catch signals

# GDB scripts
define hook-stop
  x/i $rip
  x/4gx $rsp
end
```

### pwndbg / GEF Extensions

```
vmmap                                  # memory map
heap                                   # heap overview
bins                                   # freelist bins
telescope $rsp 20                      # smart stack view
search -s "flag"                       # search memory
```

## Frida

Dynamic instrumentation — hook functions, modify behavior, trace calls.

```python
import frida

session = frida.attach("binary")  # or frida.spawn("./binary")

script = session.create_script('''
// Hook a function by address
Interceptor.attach(ptr("0xADDR"), {
    onEnter(args) {
        console.log("arg0:", args[0].toInt32());
        console.log("arg1:", args[1].readUtf8String());
    },
    onLeave(retval) {
        console.log("return:", retval.toInt32());
        retval.replace(1);  // modify return value
    }
});

// Hook by export name
Interceptor.attach(Module.findExportByName(null, "strcmp"), {
    onEnter(args) {
        console.log("strcmp:", args[0].readUtf8String(), args[1].readUtf8String());
    }
});

// Memory read/write
var addr = ptr("0xADDR");
console.log(addr.readByteArray(16));
addr.writeByteArray([0x41, 0x42, 0x43]);

// Search memory
Process.enumerateModules().forEach(function(m) {
    Memory.scan(m.base, m.size, "66 6C 61 67", {
        onMatch(address, size) { console.log("Found at:", address); }
    });
});
''')
script.load()
```

### Frida CLI

```bash
frida -f ./binary -l script.js         # spawn and instrument
frida-trace -i "strcmp" ./binary        # auto-trace function
```

## angr (Symbolic Execution)

```python
import angr
import claripy

proj = angr.Project('./binary', auto_load_libs=False)

# Basic: find path to address, avoid another
state = proj.factory.entry_state()
simgr = proj.factory.simgr(state)
simgr.explore(find=0xSUCCESS, avoid=0xFAIL)
if simgr.found:
    solution = simgr.found[0]
    print(solution.posix.dumps(0))  # stdin that reaches success

# Symbolic input
flag_len = 32
flag = claripy.BVS('flag', flag_len * 8)
state = proj.factory.entry_state(stdin=flag)
# Add constraints
for i in range(flag_len):
    byte = flag.get_byte(i)
    state.solver.add(byte >= 0x20)
    state.solver.add(byte <= 0x7e)

simgr = proj.factory.simgr(state)
simgr.explore(find=0xSUCCESS, avoid=0xFAIL)
if simgr.found:
    print(simgr.found[0].solver.eval(flag, cast_to=bytes))
```

### angr Tips

- `auto_load_libs=False` — faster, avoids unnecessary library analysis
- Use `avoid` addresses liberally — prune failing paths early
- For loops: set `simgr.explore(n=1)` to find first solution
- Memory: symbolic execution can explode — constrain input range

## strace / ltrace

```bash
strace ./binary <<< "input"            # syscall trace
strace -e trace=read,write ./binary    # filter syscalls
strace -e trace=openat ./binary        # file opens
strace -f ./binary                     # follow forks

ltrace ./binary <<< "input"            # library call trace
ltrace -e strcmp ./binary               # specific function
```

## Unicorn (CPU Emulation)

```python
from unicorn import *
from unicorn.x86_const import *

mu = Uc(UC_ARCH_X86, UC_MODE_64)
mu.mem_map(0x400000, 0x1000)           # map code
mu.mem_write(0x400000, code_bytes)      # write code
mu.reg_write(UC_X86_REG_RIP, 0x400000)
mu.emu_start(0x400000, 0x400000 + len(code_bytes))
result = mu.reg_read(UC_X86_REG_RAX)
```

Useful for emulating isolated functions (e.g., decryption routines)
without running the full binary.

## QEMU User-Mode

```bash
# Run foreign-architecture binary
qemu-x86_64 ./binary                   # x86-64 on ARM host
qemu-arm ./binary                      # ARM on x86 host
qemu-mipsel ./binary                   # MIPS

# With GDB
qemu-x86_64 -g 1234 ./binary           # GDB server on :1234
```
