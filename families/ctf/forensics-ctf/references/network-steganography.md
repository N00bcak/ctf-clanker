# Network Steganography

## DNS Exfiltration

**Detection**: Unusually long subdomain labels, high DNS query volume,
TXT record queries/responses with encoded data.

```bash
# Extract DNS query names
tshark -r <pcap> -Y "dns.qry.name" -T fields -e dns.qry.name | sort -u

# Look for hex/base64 encoded subdomains
# Example: 48656c6c6f.evil.com → "Hello"
tshark -r <pcap> -Y "dns.qry.name contains evil.com" -T fields -e dns.qry.name | \
  cut -d. -f1 | xxd -r -p

# TXT record exfiltration
tshark -r <pcap> -Y "dns.txt" -T fields -e dns.txt
```

## ICMP Tunneling

**Detection**: ICMP packets with unusual payload sizes or data content.

```bash
# Extract ICMP payload data
tshark -r <pcap> -Y "icmp" -T fields -e data | xxd -r -p

# Compare request and reply payloads — differences may be data
tshark -r <pcap> -Y "icmp.type==8" -T fields -e data  # echo request
tshark -r <pcap> -Y "icmp.type==0" -T fields -e data  # echo reply
```

## TCP Flag Covert Channel

**Detection**: Data encoded in TCP flags, urgent pointer, sequence
numbers, or window size.

```bash
# Extract specific TCP fields
tshark -r <pcap> -T fields -e tcp.flags -e tcp.urgent_pointer -e tcp.window_size_value

# Flag-based encoding: specific flags map to bits
# Example: SYN=1, RST=0, sequence encodes base64
```

## Packet Timing Covert Channel

**Detection**: Inter-packet delays encode binary data (long delay = 1,
short delay = 0, or similar).

```python
# Extract timestamps and compute intervals
import subprocess, struct

output = subprocess.check_output([
    'tshark', '-r', 'capture.pcap', '-T', 'fields', '-e', 'frame.time_epoch'
])
timestamps = [float(t) for t in output.decode().strip().split('\n')]
intervals = [timestamps[i+1] - timestamps[i] for i in range(len(timestamps)-1)]

# Classify intervals as 0 or 1
threshold = sum(intervals) / len(intervals)
bits = ''.join('1' if d > threshold else '0' for d in intervals)
# Convert bits to bytes
```

## HTTP Steganography

- Data in custom headers (`X-Custom-Header: encoded_data`)
- Data in URL parameters (`?data=base64_encoded`)
- Data in POST body disguised as form data
- Data in cookie values
- Data in User-Agent strings
- Whitespace encoding in response bodies

## Protocol-Level Hiding

| Method | Detection |
|---|---|
| TCP ISN (initial sequence number) | Check for non-random ISN patterns |
| IP ID field | Sequential or patterned IP IDs |
| TTL encoding | Unusual TTL values |
| IPv6 flow label | Non-zero flow labels |
| VLAN tags | Unexpected VLAN IDs |
| 802.11 beacon frames | Data in SSID or IE fields |
