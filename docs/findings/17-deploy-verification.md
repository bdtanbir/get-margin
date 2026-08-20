# Deploy verification checklist — run this before trusting `infra/`

**Status: NOT RUN. Nothing in `infra/` has ever been executed.**

```
$ docker info
ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
```

The Docker CLI is installed on the machine that wrote those files; the daemon is not running, so
no image was built, no container was started, and no property claimed in `infra/` has been
observed. This document is the list of things that must be run, what to look for, and what a pass
actually looks like — written so that a failure is distinguishable from a pass, which is the part
these checklists usually get wrong.

**Until every item below has a recorded result, `infra/` is a proposal.** `PLAN.md` §4 names the
converters as the real security surface, and `PHASE-7-DESIGN.md` §0 is explicit that unverified
sandbox configuration is worse than none, because it reads as protection while providing an unknown
amount of it. Do not cite any of this configuration as a control in a security review until this
page has results in it.

## How to record a result

Append to each item: the date, the command run verbatim, the output, and **pass** or **fail**. A
result of "looks fine" is not a result. If an item cannot be run, say so and say why — an item
skipped silently is indistinguishable from an item passed.

---

## 1. The images build at all

```
docker compose -f infra/compose.yaml build
```

**Expect this to fail the first time.** Two things in it are known-unverified:

- The apt package list in `Dockerfile.worker` is the documented Chromium dependency set for Debian
  bookworm, typed from documentation rather than resolved by apt. A missing or renamed package is
  the most likely first failure.
- `pnpm install --filter` with only some workspace manifests copied may not resolve; the lockfile
  covers the whole workspace.

**Pass:** both images build, and `docker image ls` shows them. Record the sizes — a worker image
much under 1 GB probably means Chromium did not actually install, which item 3 will confirm.

## 2. The entrypoints exist and start

`Dockerfile.worker` names `apps/worker/src/main.ts`, **which does not exist**. The worker currently
ships a converter registry and a handler factory (`apps/worker/src/index.ts`) and no
queue-consuming entrypoint, because the only queue that exists is in-process and there is no Redis
here to consume from (`docs/findings/16-phase-7-preflight.md`). Whoever wires BullMQ writes that
file; until they do, the worker container cannot start and this item fails by construction.

Both entrypoints also run under `node --experimental-strip-types`, which this repo has never done —
development and tests go through `tsx`. Node ≥ 22.6 is required, and stripping rejects some
TypeScript that `tsx` accepts (notably `enum` and parameter properties).

```
docker compose -f infra/compose.yaml up -d api
docker compose -f infra/compose.yaml logs api
curl -sS http://127.0.0.1:3000/health
```

**Pass:** `{"ok":true}`, and no `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` or
`Unknown file extension ".ts"` in the logs.

## 3. The worker can actually convert something

An image that builds and a converter that runs are different claims.

```
docker compose -f infra/compose.yaml run --rm worker \
  node --experimental-strip-types -e "
    import('./apps/worker/src/index.ts').then(async (m) => {
      const c = m.createRegistry().get('html-to-pdf')
      const out = await c.convert(new TextEncoder().encode('<h1>hi</h1>'))
      console.log('bytes', out.length, 'magic', new TextDecoder().decode(out.subarray(0,5)))
    })"
```

**Pass:** a byte count over a few thousand and `magic %PDF-`. **Fail** with
`browserType.launch: Executable doesn't exist` means the apt list or the browser download in
item 1 is wrong, whatever the build said.

## 4. The read-only root filesystem holds, and the tmpdir works

```
docker compose -f infra/compose.yaml exec worker sh -c 'touch /app/x'          # expect failure
docker compose -f infra/compose.yaml exec worker sh -c 'touch /tmp/margin/x'   # expect success
docker compose -f infra/compose.yaml exec worker id
```

**Pass:** the first is `Read-only file system`, the second succeeds, and `id` reports `uid=1000`
and not `uid=0`. If Chromium fails to render after this, it is writing somewhere other than
`TMPDIR`; find where before widening anything — adding a writable mount to make an error go away is
how a sandbox quietly stops being one.

## 5. Egress is actually blocked — the item most likely to be assumed rather than tested

This is the one that matters most and the one people skip. `internal: true` is *supposed* to mean
Docker creates no gateway for that network. Verify it rather than believing it.

```
docker compose -f infra/compose.yaml exec worker sh -c \
  'timeout 5 getent hosts example.com; echo "dns rc=$?"'
docker compose -f infra/compose.yaml exec worker sh -c \
  'timeout 5 wget -qO- http://1.1.1.1 ; echo "http rc=$?"'
docker compose -f infra/compose.yaml exec worker sh -c \
  'timeout 5 wget -qO- http://169.254.169.254/latest/meta-data/ ; echo "metadata rc=$?"'
docker compose -f infra/compose.yaml exec worker ip route
```

**Pass:** all three time out or fail to resolve, and `ip route` shows **no default route**. A
default route pointing at a bridge gateway means egress is open no matter what the compose file
says.

The metadata address is called out separately because it is the one that matters even when general
internet egress is blocked: on a cloud host it hands out instance credentials to anything that can
reach it, and an attacker-controlled document that reaches it has escalated from "rendered a page"
to "has your IAM role".

**Note what this item does NOT cover.** The worker still reaches Redis, which is the point. If
Redis is ever exposed on a routable network, this item's pass becomes meaningless.

## 6. The seccomp profile — merge it before applying it

`infra/seccomp.json` is **allow-by-default with a deny list**. Docker's built-in profile is
**deny-by-default with an allowlist**. `security_opt: seccomp:<file>` replaces rather than merges,
so applying `seccomp.json` directly would swap a strict profile for a permissive one and leave the
container weaker than if the option were absent. That is why the line is commented out in
`compose.yaml`.

To produce a profile that is genuinely stricter:

1. Take `profiles/seccomp/default.json` from the moby source tree at the Docker version in use.
2. Remove every syscall name listed in `infra/seccomp.json` from that file's allowlist. Keep the
   argument filters on `clone`, `clone3`, `unshare`, and `setns` — Chromium builds its own renderer
   sandbox from user and PID namespaces, and denying those disables Chromium's sandbox, which is a
   net loss.
3. Apply the merged file and re-run item 3.

```
docker compose -f infra/compose.yaml exec worker grep Seccomp /proc/1/status
```

**Pass:** `Seccomp: 2` (filter mode), item 3 still produces `%PDF-`, and the merged profile is
strictly smaller than the default's allowlist — diff them and confirm the change is only removals.
Specifically re-check `io_uring_*`: glibc and Node use it for async IO on some builds, and denying
it may break the runtime rather than the attacker.

## 7. The resource limits bind

```
docker compose -f infra/compose.yaml exec worker sh -c 'cat /sys/fs/cgroup/memory.max'
docker compose -f infra/compose.yaml exec worker sh -c 'cat /sys/fs/cgroup/cpu.max'
```

**Pass:** roughly `2147483648` and a quota consistent with 2 CPUs — not `max`. `deploy.resources`
is **ignored by `docker compose up`** outside Swarm on some versions; if these read `max`, switch to
top-level `mem_limit` / `cpus`. A limit that is silently ignored is the same as no limit, and it is
the kind of thing that reads as configured in a review.

Then confirm it is enforced rather than merely set: feed a document that allocates hard and watch
the container get OOM-killed rather than the host degrade.

```
docker compose -f infra/compose.yaml exec worker sh -c \
  'node -e "const a=[];for(;;)a.push(Buffer.alloc(50<<20))"' ; echo "rc=$?"
```

**Pass:** the process dies quickly, `docker inspect` shows `OOMKilled: true`, and the **host stays
responsive**.

## 8. Deletion survives a restart

The privacy claim is only as good as the deletion, and a container restart is where an orphan hides.

1. Submit a job, and stop the worker before it finishes.
2. `docker compose -f infra/compose.yaml exec api ls /var/lib/margin/jobs` — one directory.
3. Restart the API and wait past the TTL (or set `JOB_TTL_MS` low for the test).
4. List again.

**Pass:** the directory is gone. The sweeper is an in-process interval, so this specifically tests
that it survives a restart and picks up orphans it did not create.

## 9. Nothing sensitive reaches the logs

```
docker compose -f infra/compose.yaml logs api | grep -i -e 'tax-return' -e '\.html' -e '\.pdf'
```

Submit a job whose filename is `2024-tax-return-jane-doe.html` first.

**Pass:** no matches. This is covered by unit tests (`apps/api/test/logging.test.ts` asserts on the
output bytes), but the container adds Docker's own log driver and any startup banner, which the unit
tests never see.

## 10. The API is the only thing reachable

```
docker compose -f infra/compose.yaml ps
nmap -sT -p- 127.0.0.1        # or: ss -ltnp
```

**Pass:** port 3000 is published and **nothing else is** — no Redis on 6379, no worker port at all.
The worker listens on nothing by design; if it appears here, something has been added that should
not have been.

---

## What this checklist cannot tell you

Passing every item means the containers behave as configured. It does **not** mean the sandbox is
sufficient for LibreOffice, Ghostscript, or Tesseract. Those are not in these images, and
`PHASE-7-DESIGN.md` §0 explains why they were not written blind. Adding them is a new security
review, not a re-run of this page — they need a stricter profile than Chromium does, and they fail
differently: Chromium crashes on malformed input, LibreOffice hangs on it.
