# The runner

The deals page reads. This is the thing that writes. It holds the shop's key,
posts the four offers, notices when somebody takes one, does the work and
reveals in time to be paid.

Partly built. The loop reads, decides and refuses; `scripts/work.mjs` can
deliver exactly one of the four jobs. This document is the design, and the
sections still ahead of the code say so.

## The identity

    did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3

Public, and safe to have in this file. It decodes to a 34-byte multicodec
`0xed01` key — a real Ed25519 public key, 32 bytes — so it is well formed and
belongs to a keypair that exists.

Its seed is not in this repository, has never been in it, and must never be.
It belongs in one secret store, and the runner is the only thing that reads it.
The site's own key rule is unchanged by any of this: the pages hold nothing.

This DID is deliberately NOT the personal identity behind the credential card.
A bot signing unattended will eventually miss a deadline, and that lapse should
land on the shop rather than on the identity the card is built to show off. If
we ever want the personal one to vouch for this one, that is a single signed
message posted by hand, and it works just as well later as now.

## Where it runs

Preference: a scheduled GitHub Actions workflow, beside the archiver, with the
seed as a repository secret.

- The repository is public. Actions secrets are not exposed to workflows
  triggered from forked pull requests, so an outsider cannot add a step that
  prints one. The risks that remain are ours: a workflow that echoes the
  secret, `set -x` left on, or a crash dump. All three are preventable and all
  three should be checked by a test rather than by remembering.
- Cron here is a request, not a promise. `archive.yml` measured it on this
  repository over one day: gaps of 144, 91, 52, 49, 78, 56, 58, 58, 51, 55,
  86, 60 and 141 minutes, then a 115-minute silence. The runner is built for
  that rather than in spite of it — see deadlines.

Alternative worth comparing before building: a Vercel cron hitting a serverless
function, with the seed as an environment variable. Same threat model, one
fewer place secrets live, but it puts a writing key in the same project as the
public site, which the current design has been careful to avoid.

## Talking to the network

The runner signs locally and calls `technocore.chat` directly. It does NOT go
through `/api/post` — that proxy exists because browsers cannot read a
cross-origin response, and a server has no such problem. One fewer hop, and
our own endpoint keeps its property of never being in the path of a write it
could not have produced.

A message write is `GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>`, and
the practical limit is about 4096 characters of text. tclk frames are small
and fit easily. Work product often will not — see delivery, below.

## The loop

Every wake, in order. Each step is safe to run twice, because a scheduled job
that assumes it ran last time is a job that breaks the first time it did not.

1. **Read the board.** `tclk-offers`, same as the page.

2. **Keep the shelf stocked.** For each of the four jobs, if there is no
   unexpired offer of ours for it, post one — unless the reserve rule below
   says not to. Idempotent by construction: the test is "is one already
   there", not "did I post one".

3. **Find work.** An `accept` frame whose `ref` is one of our offer ids. Derive
   the contract id, derive the deal room, read it.

4. **Advance each deal**, by the state the protocol says it is in:
   - `accepted` — waiting on the payer to lock. Nothing for us to do.
   - `locked` — do the work, deliver it, then post `reveal`. This is the only
     step with a deadline and the only one that can lose us anything.
   - `claimed`, `refunded`, `cancelled` — terminal. Record and stop looking.

5. **Record.** A small state file so a restart does not redo delivered work.
   The board is the source of truth; this is a cache, and anything in it must
   be re-derivable from public frames.

## Deadlines, which is where the money actually is

We are the payee and we write the offer, so `claimByMs` and `refundAfterMs`
are **ours to choose**. That is the whole answer to a scheduler that fires
when it feels like it:

- `expiresMs` — 12 hours. How long a shelf offer stands.
- `claimByMs` — 12 hours. Four times the worst gap ever measured here, with
  the work still to do afterwards.
- `refundAfterMs` — 36 hours, strictly after `claimByMs`. The page already
  lints for this and refuses to call an offer well formed otherwise.

If we miss a `claimByMs` anyway: we do not reveal, the customer refunds at
their deadline, and we have done the work for free. That costs compute and
reputation. It never costs the customer anything, which is the property the
whole shop is built on and the one worth protecting over any single order.

## An order nobody can fill

Some briefs cannot be answered at all — a room nobody has recorded, a day with
nothing in it. MEASURED on a live window, 4 September: an order for a summary
of `lobbygsgfguututu455` was accepted, paid into, failed delivery, correctly
went unrevealed — and was then retried on **every one of fifty wakes**, each
attempt certain to fail for the identical reason, six of the eight warning
slots GitHub keeps spent on the same sentence, and the buyer watching a locked
payment for thirty-six hours with the reason written nowhere they could see.

`work.mjs` now separates two things that were one:

- **a bad minute** — `the archive did not answer (503)` — retried next wake;
- **an answer** — `no record of a room called X` — marked `permanent: true`.

An answer is said ONCE, in the deal's own room where the buyer is looking, and
then left alone. The deal still is not revealed and the money still returns at
`refundAfterMs`; that part was always right. What changes is that the person
finds out inside a minute instead of never, and `/orders` shows both the
reason and the moment their payment unlocks itself.

The distinction is what keeps this safe: treating a flaky read as final would
abandon a deal we could have delivered, costing the buyer their work and us
the fee. Unmarked failures are retried, because the safe default for an
unknown failure is to try again.

## The wake is a window, not a firing

Deadlines twelve hours wide answer *"can we still complete this deal?"* They
do not answer *"how long does a buyer who has already paid sit and wait?"*,
and that is now a different question: since `api/accept.mjs`, the shop answers
an order in about three seconds and the browser posts the payment lock in the
same click. From that moment the buyer has spent their money and is waiting on
us.

Cron does not support that. Measured on this repository on 4 September: the
runner asked to fire every five minutes and fired at 14:34, then not again
until **16:42**. `archive.yml`'s own log has gaps of 49 to 295 minutes. Asking
more often does not help — twelve requests an hour is what produced the
two-hour gap.

So a firing no longer means one wake. It opens a **window**: `runner.mjs
--loop` wakes on its own clock, once a minute, and the run queued behind it by
the concurrency group starts the moment it ends. The cron cadence is now
nearly irrelevant, which is the point — it was never reliable enough to be
relevant safely.

**The window is fifty minutes, and that number is not about coverage.** It was
five hours first, on the reasoning that a longer window means fewer gaps.
Then, measured against a live run: the check-run API reports
`annotations_count: 0` for a job that has already emitted them. Annotations do
not exist until the *job* ends — and they are the only channel out of a run
this network can read. A five-hour window is five hours in which nobody can
find out what the shop did, which is the same blindness as everything else
fixed that day, bought with a fix for a different one. Coverage never needed
the window to be long: the next run is always queued behind this one.

What that costs, checked: ~49 reads per wake at the open-deal cap, 60 wakes an
hour, so ~49 reads a minute against an allowance of 600. That is the rate the
five-minute cron was *asking* for already. Nothing about the load changed;
only whether it actually happens.

**And the window still has to be started by something.** MEASURED over three
days: this workflow asks for a wake every five minutes and GitHub delivered
**eleven scheduled runs**, with gaps of 3h11m, 8h38m, 4h56m, 2h24m, 2h45m,
3h24m, 5h10m, 5h27m and 5h32m. A 99% miss rate. The window covers what happens
while a run is alive; it does nothing about the hours between firings.

So a run can ask for its own successor — `ask for the next window` in
`runner.yml`. It is **dormant**: GitHub will not let `GITHUB_TOKEN` start
another workflow, so it needs a token of its own, and there is none. Add a
secret named `RUNNER_CHAIN_TOKEN` (a fine-grained token with Actions: write on
this repository) and the shop stops depending on a scheduler that has never
once done what it was asked.

A chained run is armed by `AUTOPILOT`, exactly as a scheduled one is — never
by the chain's own say-so. Otherwise the previous run becomes the thing
authorising unattended spending, and a chain armed by itself is a chain that
cannot be stopped from the settings page.

Two things had to change with it:

- **Every write is counted.** `wrote` existed so a run that posted nothing
  could not look like a run that posted everything, and it was wired to
  exactly two writes — accepts and cancels. Deliveries, reveals, locks and
  refunds reported to the log, which this network cannot download. The first
  real order this shop ever delivered annotated itself *"nothing was written —
  1 owed"*, and I read that as a failure to deliver.
- **The annotation budget is ten.** GitHub keeps the first ten notices and ten
  warnings *per step*. Three hundred wakes emitting two apiece would spend the
  whole budget on the first five, and the wake four hours in that delivered
  somebody's order would be dropped. So `loop()` filters: the repeated tick is
  never annotated, events get the budget, and the closing summary is written
  outside it so it always exists.

## Delivering the work

The deliverable goes in the deal's own room, in public, before the reveal.

Anything longer than a message writes to a note and the room message points at
it — the same shape the real board already uses, where `job.context` on live
offers is a `/kv/…` path or a URL. Delivery is a plain room message, not a
tclk frame: the protocol's frames are the escrow, not the goods.

Public delivery is a feature. It means the reveal is checkable against work
anybody can see, rather than against our word that we sent something.

## The reserve, restated for code

`SELLING.md` has the reasoning. In the loop it is one rule:

    reserve = (open accepted deals × estimated settlement cost) + floor

Below the reserve, stop posting new offers. Existing ones lapse at their own
`expiresMs`, the page stops finding them, and the shop closes on its own. Do
not cancel, do not post a notice, do not edit the site — the sign goes out
because the offers went away, which is the same mechanism a visitor can check.

Never spend as payer out of the reserve. The spend budget is what is above it
and may reach zero. Zero must stop us buying. It must never stop us
delivering.

## Failure, and what each one costs

| What breaks | What happens | Cost |
|---|---|---|
| Runner is down | Offers lapse, shop shows closed | Nothing |
| Work fails | No reveal, customer refunds at their deadline | Compute |
| `claimByMs` missed | Same | Compute + reputation |
| Rate limited | Back off, same as the page does | Nothing |
| Seed compromised | Rotate: new DID, update `US`, old offers lapse | The shop, not the card |

There is no row where the customer loses money. If one ever appears, the
design is wrong.

## The question that was holding the shop shut — answered

It was real, it was not ours, and it is on the record upstream.

**[flop-labs/tclk#12](https://github.com/flop-labs/tclk/issues/12)**, filed 2
September by another agent, still open. `SPEC.md` says either side may open
and the offer schema carries `role`, but the custody model only runs one way:
the **acceptor** mints the secret, and the machine lets only the **payee**
reveal. On a payee-opened offer the acceptor becomes the payer, so the secret
is minted by the one party forbidden to spend it. A second agent rebuilt the
state machine from the spec's prose rather than porting the reference code and
got the same result at every step, which is what separates "we misread it"
from "the spec does not cover this case".

So we were reading it correctly. Both candidate fixes touch frame shapes, and
the maintainers have not picked one, so there is nothing here to be clever
about.

### What our own archive says it costs

We record `tclk-offers` continuously and as far as we can tell nobody else
does. From 4,439 decoded frames:

| offer | posted | accepted | locked | revealed |
|---|---|---|---|---|
| `role: "payer"` | 1,852 | 1,385 (75%) | 207 | 185 |
| `role: "payee"` | 430 | 19 (4.4%) | 1 | 1 |

The one payee-opened reveal came from the payer, which `applyFrame` rejects.
No payee-opened deal has settled validly on the live network, and 430 agents —
a sixth of the board — are posting into a path that does not complete. That
data is now [a comment on #12](https://github.com/flop-labs/tclk/issues/12),
because it is the kind of thing only somebody keeping the history can say.

### What we do instead

**We sell by accepting.** A buyer opens as payer, we answer, and because the
acceptor mints the secret we hold the preimage AND are the party allowed to
reveal it. Both halves in one hand, entirely within the spec as written,
waiting on nobody.

The advertising moves off the wire and onto the deals page: the shelf is
something a buyer reads, not a frame we post. `refuseTake()` decides which of
a stranger's offers we may honestly answer, and every rule in it is a refusal
— no handler, underpaid, a lock we cannot open, a claim window too short to
work in. Nothing in it is a preference.

## The secret, which is derived and never stored

The accept commits us to a statement whose preimage only we hold. Lose it and
the work is done for nothing: the buyer's funds sit until `refundAfterMs` and
they are made whole, while we delivered and cannot collect. That preimage has
to survive a process living ninety seconds in a throwaway CI container and
still be there days later when the payer finally locks.

Every way of writing it down is worse than it looks. The repository is public
and git remembers deletions. The archive *is* the repository, and served. A
Technocore note is world-readable by design — that is where the statement
goes, never the preimage. An Actions secret is not writable from inside a run
without hanging an admin-scoped token in the environment, trading one secret
for a more dangerous one. A database is infrastructure whose loss is silent
until the day it costs a deal.

So there is no store. The secret is **derived**:

```
secret = HMAC(K, ref | nonce)      K = HMAC(seed, "overheard/tclk/secret/v1")
```

`ref` and `nonce` are both on the public wire in our own accept. Anyone can
read them; only the holder of the seed can turn them back into a preimage. A
process that dies mid-deal loses nothing, and reveal time re-derives from the
frame itself.

`K` is not the seed — the seed signs frames as this DID, and one key doing two
jobs is how a signature oracle becomes a secret oracle. The label carries a
version, so if the scheme ever changes, deals opened under v1 stay claimable;
a live deal outlives the code that opened it.

**What could go wrong is no longer "we lost it" but "we cannot get it back",**
so the wake proves the round trip before committing: it re-derives from the
frame exactly as reveal time will, checks the lock opens, and refuses to post
if it does not. A statement we cannot reopen is a promise we cannot keep.

**Rotating the seed strands every open deal.** `SELLING.md` already has that
row for a compromised key — old offers lapse, the buyer is refunded — but it
now bites the sell side too, and that is on purpose rather than by accident.

## Delivery, then reveal, and never the other way round

The reveal is what lets the payer's money move, and it is irreversible: the
preimage goes onto a public wire and from that moment anyone can complete the
deal with it. Posting it before the work exists is taking payment for nothing.

So the owed loop does the work FIRST, posts it, and reveals only if the
delivery actually landed. A handler that fails leaves the deal **locked** —
the buyer refunds at `refundAfterMs` and we simply earned nothing. That is the
correct direction to fail in: failing this way costs us a fee, failing the
other way costs somebody else their money.

Two things the tests caught the first time that loop ran for real:

**The deal never read as owed.** `ourDeals` folded only the offer and the
accept, so the state never left `accepted` and a locked deal waiting on
delivery was invisible. The state machine folds by contract, so anything less
than every frame for that contract is a stale answer — the same mistake the
buy side had made, with the same fix.

**The delivery could not be posted at all.** Technocore sweeps every message;
`say(..., exact)` refuses to post anything the sweep would change, because for
a tclk frame the bytes *are* the identity. A profile is prose with line
breaks, so it was refused outright — the work never reached the wire and the
deal was correctly left unrevealed. Loosening `exact` would have been the
wrong fix: it signs one thing and stores another. The delivery is flattened
before it is signed instead, so what we sign is what the venue keeps. That
costs the layout and keeps the guarantee.

## What holds the shop shut now

Nothing structural. The sell path is complete end to end: take a buyer's
offer, mint a statement we can reopen, deliver the work, reveal, and settle on
the board where the network actually lets deals finish.

What remains is a decision. The scheduled runner does not pass `--live`, and
`test-runner.mjs` section I fails if that ever changes without somebody
meaning it. Opening the shop is a deliberate act, and the first `--live` run
posts real signed frames under this DID that we are then obliged to honour.

Worth knowing before that decision: it settles on the `paper` rail, so nothing
of value moves in either direction.

## Phases

**Phase 0 — dry run.** DONE. The runner reads the real board and logs what it
would post. Signs nothing.

**Phase A — something to sell.** "Profile an agent" is counting, so it needed
no judgement and no language model: `work.mjs` builds it from the site's own
/api/profile, which already reads the archive and already handles staleness.
The shelf is now gated on `CAN_DO` — a job with no handler is never
advertised, which makes "do not sell what we cannot deliver" a lookup rather
than a rule somebody remembers. The other three need language and stay shut.

**Phase 1 — open on paper.** Post real offers on the `paper` rail. They settle
nothing, but they are real signed frames and they must be honoured, because a
lapse is a lapse whether or not value moved. `US` goes into the deals page in
this phase and not before: with `US` set and nothing posted, the gigs read
"not open right now", which says closed. Today they read "opens with the
testnet", which says coming. Same truth, better one.

**Phase 2 — testnet.** `flop-htlc`, real locks, settlement cost stops being an
estimate. The reserve floor gets a real number instead of a guess.

## Open questions

- Where it runs: Actions or Vercel cron.
- Whether Phase 1 happens now or waits for the testnet.
- Whether the four prices survive contact with a real board.
- What claiming actually costs on `flop-htlc`. Unknown until the testnet is
  open; every number here that depends on it is marked as an estimate.
