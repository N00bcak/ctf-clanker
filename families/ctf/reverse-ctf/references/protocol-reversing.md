# Network Protocol Reversing

**When**: Challenge binary communicates over a network — reverse the protocol to interact directly or exploit it.

## Capture Traffic
```bash
# Run binary and capture its traffic
tcpdump -i lo -w capture.pcap port 1337 &
./server &
./client

# Or use strace to see socket operations
strace -e trace=network,read,write ./binary
```

## Identify Protocol Structure
```python
# Common patterns in binary protocols:
# [length][type/opcode][payload]
# [magic][version][type][length][payload][checksum]

# Text protocols: look for \r\n delimiters, ASCII commands
# Binary protocols: look for fixed-size headers, length fields
```

### Wireshark Custom Dissector
```lua
-- For unknown protocols, write a Wireshark Lua dissector
local p = Proto("custom", "Custom Protocol")
local f_len = ProtoField.uint16("custom.len", "Length")
local f_type = ProtoField.uint8("custom.type", "Type")
p.fields = {f_len, f_type}
function p.dissector(buf, pkt, tree)
    local subtree = tree:add(p, buf())
    subtree:add(f_len, buf(0,2))
    subtree:add(f_type, buf(2,1))
end
local tcp = DissectorTable.get("tcp.port")
tcp:add(1337, p)
```

## Replay and Modify
```python
# pwntools for raw TCP interaction
from pwn import *
r = remote('localhost', 1337)

# Replay captured sequence
r.send(b'\x00\x0a\x01' + b'hello')     # [len=10][type=1][payload]
response = r.recv(1024)

# Parse response
resp_len = u16(response[:2])
resp_type = response[2]
resp_data = response[3:3+resp_len]
```

## Common Protocol Patterns

### Length-Prefixed Messages
```python
# Read: recv length field, then recv that many bytes
def recv_msg(r):
    length = u32(r.recv(4))
    return r.recv(length)

def send_msg(r, data):
    r.send(p32(len(data)) + data)
```

### Type-Length-Value (TLV)
```python
def parse_tlv(data):
    results = []
    i = 0
    while i < len(data):
        typ = data[i]
        length = u16(data[i+1:i+3])
        value = data[i+3:i+3+length]
        results.append((typ, value))
        i += 3 + length
    return results
```

### Checksums
```python
# CRC32
import binascii
checksum = binascii.crc32(data) & 0xffffffff

# Simple XOR checksum
checksum = 0
for b in data: checksum ^= b

# Custom: reverse the checksum algorithm from the binary
```

### Encryption/Obfuscation
```python
# XOR with key
def decrypt(data, key):
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))

# If protocol uses TLS: extract keys via SSLKEYLOGFILE or from binary memory
```

## Approach
1. **Capture** clean traffic between legitimate client and server.
2. **Identify** message boundaries (length fields, delimiters, fixed-size messages).
3. **Map** opcodes to operations (login, query, action, response).
4. **Replay** captured messages to verify understanding.
5. **Modify** messages to test for vulnerabilities (buffer overflow in length field, type confusion, command injection in text fields).
6. **Script** a client using pwntools for exploitation.

## Trap
- Endianness: network byte order is big-endian, but the binary may use little-endian internally. Check with `struct.unpack('>I', data)` vs `struct.unpack('<I', data)`.
- Alignment: some protocols pad to 4-byte or 8-byte boundaries.
- State machines: some protocols require specific message ordering (handshake before command).
