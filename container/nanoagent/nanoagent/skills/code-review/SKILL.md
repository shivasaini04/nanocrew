---
name: code-review
description: "Use when reviewing a pull request, diff, or code change. Applies a structured 4-layer review: correctness → security → performance → style."
tags: [code-review, quality, security, github, pull-request]
related_skills: [systematic-debugging, test-driven-development]
version: 1.0.0
author: nanocrew
---

# Code Review

Code review is the last checkpoint before untested or unsafe code reaches production. A good review is not a spell-check — it is a structured analysis that catches logic errors, security vulnerabilities, performance regressions, and design problems before they are embedded in the codebase.

This skill enforces a layered review order: you evaluate correctness before style, because a beautifully formatted function that has a logic error is still broken.

## When to Use

Trigger this skill when:

- A user says "review this PR", "review this diff", or "look at this code"
- A pull request URL is provided
- A file or diff is shared for feedback
- A user asks if code is "good" or "ready to merge"

---

## Review Order

Always review in this order. Do not comment on style if correctness is not yet confirmed. A style comment on incorrect code wastes everyone's time.

```
Layer 1: CORRECTNESS    — Does it do what it claims?
Layer 2: SECURITY       — Can it be exploited or does it expose data?
Layer 3: PERFORMANCE    — Will it hold up under realistic load?
Layer 4: STYLE          — Is it clear, consistent, and maintainable?
```

---

## Layer 1 — Correctness

This is the most important layer. Code that is elegant but wrong is broken.

### What to look for

**Logic errors**
- Does the algorithm produce correct output for all valid inputs?
- Are boundary conditions handled? (empty list, zero, negative numbers, maximum values)
- Are conditional branches exhaustive? Does `if/else if` need a final `else`?
- Does the function return a value in all code paths?

**Error handling**
- Are all error paths handled explicitly, not silently swallowed?
- Does the code distinguish between expected errors (user input validation) and unexpected errors (disk full, network timeout)?
- Are exceptions re-raised with context rather than swallowed with a bare `except: pass`?

**State and mutations**
- Is shared mutable state accessed safely?
- Does the code assume state that could have been modified by another function or goroutine?
- Are side effects clearly bounded and documented?

**Contracts and invariants**
- Does the code uphold the interface contract of the module it belongs to?
- Are preconditions checked at function entry where needed?
- Are postconditions verifiable (can you write a test for the output)?

**Test coverage**
- Do tests exist for this change?
- Do the tests cover the happy path *and* the error paths?
- Are edge cases tested? (empty input, null, concurrent access, large input)

### Checklist

- [ ] Logic is correct for all valid inputs
- [ ] Boundary conditions are handled
- [ ] Error paths are handled explicitly and not swallowed
- [ ] All code paths return a value (where applicable)
- [ ] Shared state is accessed safely
- [ ] Tests cover the new behavior including edge cases

---

## Layer 2 — Security

Security vulnerabilities are correctness bugs with an attacker actively trying to find them. Review every change that touches user input, authentication, authorization, or external systems.

### What to look for

**Input validation and injection**
- Is all external input (HTTP params, file contents, API responses, environment variables) validated before use?
- Is user input ever interpolated directly into a SQL query, shell command, or HTML output?
- Are file paths sanitized to prevent path traversal (`../../etc/passwd`)?

```python
# Red flag: shell injection
exec_cmd = f"convert {user_supplied_filename} output.png"
subprocess.run(exec_cmd, shell=True)  # NEVER do this

# Correct: parameterized, no shell=True
subprocess.run(["convert", user_supplied_filename, "output.png"])
```

**Authentication and authorization**
- Does the code verify that the *caller* is who they claim to be (authentication)?
- Does the code verify that the *authenticated caller* is allowed to perform this action (authorization)?
- Are these checks present on every path that accesses restricted data, not just the front door?

**Secrets and credentials**
- Are secrets (API keys, passwords, tokens) ever hardcoded or logged?
- Are they read from environment variables or a secrets manager, not from source files?
- Does any logging statement include request headers, cookies, or tokens?

```typescript
// Red flag: secret in source
const apiKey = "sk-live-abc123"; // Never

// Red flag: secret in log
console.log("Request headers:", JSON.stringify(req.headers)); // Logs Authorization

// Correct
const apiKey = process.env.API_KEY;
```

**Cryptography**
- Is sensitive data encrypted at rest and in transit?
- Are passwords stored as hashes (bcrypt, argon2) — never plaintext or MD5/SHA1?
- Are JWT secrets or signing keys appropriately long and random?
- Is TLS verification disabled anywhere? (`verify=False`, `rejectUnauthorized: false`)

**Dependencies**
- Does the change add a new dependency? If so, is it well-maintained and does it have known CVEs?

### Red Flags That Require Blocking the PR

These issues must be fixed before the PR can be merged. Post a blocking comment:

- SQL injection via string interpolation
- Shell injection via `shell=True` or equivalent with user input
- Hardcoded secrets or credentials in source
- Authorization bypass (missing `if not user.is_authorized()` check)
- TLS verification disabled in production code
- Password stored as plaintext or weak hash (MD5, SHA1)
- Sensitive data logged (passwords, tokens, PII)
- Path traversal vulnerability

### Checklist

- [ ] All external input is validated before use
- [ ] No SQL, shell, or HTML injection vectors
- [ ] Authentication and authorization checks are present on all restricted paths
- [ ] No secrets hardcoded in source
- [ ] Sensitive data is not logged
- [ ] Passwords are hashed with a strong algorithm
- [ ] TLS verification is not disabled
- [ ] New dependencies are vetted

---

## Layer 3 — Performance

Performance bugs are silent until they aren't. A query that returns 10 rows in dev returns 10 million in prod.

### What to look for

**N+1 queries**
The most common performance bug in database-backed applications: loading a list of records, then making a separate query for each record.

```python
# Red flag: N+1
orders = Order.query.all()
for order in orders:
    customer = Customer.query.get(order.customer_id)  # 1 query per order
    print(customer.name)

# Correct: eager load
orders = Order.query.options(joinedload(Order.customer)).all()
for order in orders:
    print(order.customer.name)  # no additional queries
```

**Missing indexes**
- Does the query filter, sort, or join on a column that is not indexed?
- For large tables, an unindexed filter can mean a full table scan.

**Unbounded operations**
- Does any loop, query, or data load have no upper bound on the number of items processed?
- Is there a missing `LIMIT` clause on a database query?
- Is pagination missing on an endpoint that returns lists?

**Memory allocation in hot paths**
- Is a large allocation (string concatenation in a loop, object creation per request) in a code path called very frequently?
- Is there a cache that should be used but isn't?

**Blocking I/O in async context**
- Is a synchronous, blocking call (disk read, blocking HTTP request) inside an async function without being properly awaited or offloaded?

### Checklist

- [ ] No N+1 query patterns
- [ ] Queries on large tables filter/sort on indexed columns
- [ ] All list-returning endpoints have pagination and `LIMIT`
- [ ] No unbounded data loads
- [ ] No blocking I/O in async context
- [ ] Hot paths do not contain unnecessary allocations

---

## Layer 4 — Style

Style is the lowest-priority layer, but it matters for long-term maintainability. A codebase that is consistently styled is easier to read, search, and modify.

### What to look for

**Naming**
- Do names describe *what*, not *how*? (`user_list` not `arr`, `fetchUserById` not `doQuery`)
- Are boolean variables named as questions? (`is_active`, `has_permission`, `can_edit`)
- Are names consistent with the conventions of the surrounding codebase?

**Function size and responsibility**
- Does each function do one thing? A function that does two things should probably be two functions.
- Is a function longer than ~40 lines? If so, does the length serve a genuine purpose, or is it doing too much?

**Comments**
- Do comments explain *why*, not *what*? Code already shows what it does; comments should explain non-obvious intent, business rules, or workarounds.
- Are there commented-out code blocks? These should be removed.

**Duplication**
- Is logic duplicated? Duplication is the root of most maintenance bugs — when requirements change, one copy gets updated and one does not.

**Consistency with existing code**
- Does the new code follow the same patterns as the code around it? (error handling style, async patterns, module structure)

### Checklist

- [ ] Names are descriptive and consistent with the codebase
- [ ] Functions have a single, clear responsibility
- [ ] Comments explain why, not what
- [ ] No commented-out code blocks
- [ ] No unnecessary duplication
- [ ] Code follows existing conventions in the codebase

---

## Posting Review Comments via github_api

When reviewing a GitHub PR, use `github_api` to post structured, line-level comments.

### Fetching the diff

```bash
github_api: GET /repos/{owner}/{repo}/pulls/{pull_number}/files
github_api: GET /repos/{owner}/{repo}/pulls/{pull_number}
```

### Posting an inline comment

```bash
github_api: POST /repos/{owner}/{repo}/pulls/{pull_number}/comments
{
  "body": "This query will cause N+1 when orders list grows. Consider using `joinedload(Order.customer)` here.",
  "commit_id": "<head_sha>",
  "path": "src/reports.py",
  "line": 47
}
```

### Posting a review with a verdict

```bash
github_api: POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
{
  "body": "Two blocking issues (SQL injection on line 23, missing auth check on line 88) must be fixed before merge. Style and performance are fine.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/api/users.py",
      "line": 23,
      "body": "BLOCKING: User input is interpolated directly into the SQL query. Use parameterized queries instead:\n```python\ncursor.execute('SELECT * FROM users WHERE id = %s', (user_id,))\n```"
    },
    {
      "path": "src/api/users.py",
      "line": 88,
      "body": "BLOCKING: This endpoint returns user data but does not check if the requesting user is authorized to view this account. Add `require_permission(user, 'read:user')` before the query."
    }
  ]
}
```

**Review events:**
- `COMMENT` — general feedback, no verdict
- `APPROVE` — ready to merge
- `REQUEST_CHANGES` — changes required before merge

### How to Give Feedback

**Be specific. Identify the exact line.**
Vague: "This could be more efficient."
Specific: "Line 47: this loop makes one database query per order (N+1). Use `joinedload(Order.customer)` in the initial query to fetch all customers in a single query."

**Explain why, not just what.**
Don't just say what is wrong — say why it matters. "This is a SQL injection vector" tells the author the severity and category, not just that something needs to change.

**Suggest an alternative when you block something.**
If you are requiring a change, show what the correct version looks like. A code block in the comment removes ambiguity.

**Label severity explicitly.**

Use consistent labels so the author knows what is blocking and what is not:

```
BLOCKING: Must be fixed before merge
SUGGESTION: Improvement recommended but not required
NITPICK: Minor style issue, take it or leave it
QUESTION: I want to understand this before approving
```

---

## Full Review Verification Checklist

Complete all four layers before posting a verdict:

**Correctness**
- [ ] Logic is correct for all valid inputs and boundary conditions
- [ ] Error handling is explicit and complete
- [ ] Tests cover the new behavior and edge cases

**Security**
- [ ] No injection vulnerabilities (SQL, shell, HTML)
- [ ] Authentication and authorization checks are present
- [ ] No secrets in source, no sensitive data in logs
- [ ] Dependencies are vetted

**Performance**
- [ ] No N+1 queries
- [ ] Large table queries use indexed columns
- [ ] All list endpoints are paginated

**Style**
- [ ] Names are descriptive and consistent
- [ ] Functions have single responsibility
- [ ] No duplication, no commented-out code

**Verdict**
- [ ] Blocking issues documented with line references and suggested fixes
- [ ] Review posted via `github_api` with appropriate event (APPROVE / REQUEST_CHANGES)
