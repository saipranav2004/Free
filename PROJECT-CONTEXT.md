# PAM: what this application is

A **Privileged Access Management** console. It sits between the people in an
organisation and the databases, storage and admin tools they need to touch, so
that three things become true:

1. **Nobody handles the password.** The credential lives encrypted in PAM. When
   someone opens a resource, PAM injects it. They never see it, type it, or
   know it.
2. **Access is temporary and approved.** A sensitive resource is not something
   you simply have. You request it, someone approves it, it expires.
3. **Every session is recorded.** Terminal sessions replay keystroke by
   keystroke. Desktop applications replay as video.

Without it, the normal alternative is a password in a shared vault or a
spreadsheet, used by anyone who has it, with no record of who did what.

---

## The three pieces

| Piece | What it is | Where it runs |
|---|---|---|
| **Console** | The web app people log into | The browser |
| **API** | The brain: identity, policy, vault, audit | A server |
| **Agent** | A small program on the operator's own laptop | Their machine |

The agent exists because some tools are not web pages. `psql`, MongoDB Compass
and Oracle SQL Developer run on the operator's own computer, and a browser
cannot start them. The agent can, and it records the session while it runs.

---

## The three ways to open a resource

This is the most important idea in the product. The same resource can be opened
three different ways, and they differ in **whether PAM is in the path**.

| Method | What happens | PAM in the data path? | Recorded as |
|---|---|---|---|
| **Web terminal** | A terminal in the browser tab, proxied by PAM | Yes | Terminal replay |
| **Brokered web** | PAM signs in to the app server-side and proxies it | Yes | Terminal-style activity log |
| **Desktop agent** | The agent starts a real local app | No | Terminal replay or video |

"PAM in the path" decides what can be *enforced*. When PAM is in the path it can
block copy/paste, block downloads, cap how much data leaves, and cut the session
instantly. With the desktop agent, the traffic goes from the laptop straight to
the database, so PAM can record and it can end the session, but it cannot stand
in the middle of every byte.

A resource can close off methods it does not want. A production database can say
"brokered web only", and the console then does not even offer the other buttons.

---

## What it can open

Ten kinds of resource, and for each one PAM knows every tool that can open it,
in priority order.

| Resource | Command line | Desktop app | Browser console |
|---|---|---|---|
| PostgreSQL | psql | pgAdmin 4 | |
| MongoDB | mongosh | MongoDB Compass | Atlas |
| Redis | redis-cli | RedisInsight | |
| Oracle | SQL\*Plus, SQLcl | SQL Developer | APEX |
| ClickHouse | clickhouse-client | | |
| MinIO | mc | | MinIO Console |
| Langfuse | langfuse CLI | | Langfuse web |
| Qdrant | | | Dashboard |
| Metabase | | | Metabase |
| Web app | | | any URL |

The agent walks that list top to bottom and uses the first tool actually
installed. If none is installed it says so, naming what to install, instead of
opening a session that goes nowhere. An administrator can also pin an exact path
for a tool that ships as a ZIP with no installer, which is how Oracle SQL
Developer is distributed.

---

## Who can do what

Three roles ship by default.

- **root**: one account, unlimited. Its power is not a policy; it bypasses
  policy evaluation entirely, and only root can hand out admin.
- **admin**: runs the platform day to day: resources, identities, policies,
  approvals, the vault.
- **user**: requests access, opens what they are entitled to, sees their own
  activity and nothing else.

Permissions themselves are **policies** attached to roles: an action, a
resource pattern, and allow or deny. Every request is evaluated against them,
and the decision is recorded with the session so an auditor can ask "why was
this allowed?" and get an answer.

---

## The main flows

**Signing in.** Password, then a second factor if policy requires one. An
administrator can require MFA for a role, and the console tells people who have
not enrolled yet. Sessions refresh quietly so a long piece of work is not
interrupted, and go idle after a period of inactivity.

**Requesting access (JIT).** A resource can require just-in-time approval. The
requester says what they need and why and for how long; an approver decides. The
grant is time-boxed and dies on its own.

States: `PENDING → APPROVED / DENIED / CANCELLED / EXPIRED`, and the grant that
comes out of it is `ACTIVE → EXPIRED / REVOKED`.

**Break glass.** The emergency path, for when something is broken at 3am and no
approver is awake. It is not a bypass: it is louder than the normal path. It
raises alarms, has a deliberate cooling-off wait, and every break-glass session
is flagged in the audit trail forever.

**Connecting.** Pick a resource, pick a method. Before the desktop button does
anything, the console checks what the paired machine reported it can open, so
"the client is not installed" is said *before* a session opens rather than after.

**Recording.** A command-line session is recorded as a terminal cast and replays
exactly as it happened. A desktop application is recorded as video of the
screen. A browser console is not recorded, because nothing in that path is PAM,
and the product says so rather than pretending.

**Auditing.** Every action is written to an append-only, hash-chained log, so a
tampered entry can be detected. Administrators search the whole organisation;
ordinary users see only themselves.

---

## The vault

Credentials live in **safes**, optionally in **folders** inside them. Each
credential keeps its version history and can be rotated on a schedule or on
demand. Rotation talks to the target system and actually changes the password
there, then stores the new one.

Two separate things share the word "credential", and keeping them apart matters:

- a **resource credential** is what PAM uses to open a session for a person;
- a **vault credential** is a secret an administrator stores and manages.

---

## The identity side

Beyond opening things, the console answers questions about the organisation:

- **Identities**: every account, what it holds, where it came from.
- **Roles**, with a **criticality score**: how much damage this role could do,
  scored from what it can reach, not from its name.
- **Identity graph**: the picture: an account, its roles, the policies those
  roles carry, and the resources they finally reach. It shows root's authority
  too, including the part no policy expresses.
- **Privilege paths**: the routes by which somebody could reach something
  sensitive, and the choke points worth closing.

---

## How it is built

| | |
|---|---|
| Console | React, React Query, React Router, Tailwind, React Flow, rrweb |
| API | Go, Gin, GORM, PostgreSQL |
| Agent | Go, no dependencies, one binary per platform |
| Auth | JWT with refresh, TOTP for MFA |
| Policy | An OPA-style engine with a seeded default bundle |

The agent ships for Windows, macOS (Intel and Apple Silicon) and Linux (x86 and
ARM). The console can hand someone a one-line installer that downloads the right
one, checks it against a published hash, registers the `pam-agent://` handler,
and pairs it with their account.

---

## The rules the product holds itself to

These are decisions, not accidents, and they show up all over the code:

- **A credential never reaches the browser.** Not in a response, not in a
  cookie, not in a recording.
- **A failure says which thing is wrong.** "The application rejected the stored
  credential" and "that URL is not this application" send an administrator to
  two different places, so they are never collapsed into "login failed".
- **Hiding a button is not a permission.** Every rule is enforced on the server
  as well, so typing a URL directly gets you nowhere.
- **Unknown is a real answer.** When the product does not know whether something
  is installed, it says so and lets you try, rather than guessing and telling
  you to install software you may already have.
