# What happens when a hundred people order at once

Written because the question was asked plainly and deserved a plain answer:
*the day we open to the public, hundreds of orders arrive — do customers stop
being able to order?*

**No. Ordering never blocks.** Placing an order is posting a signed message to
a public board. We are not in that path and could not stop it if we wanted to.
A thousand people can order in the same second and every one of those orders
lands.

What has a limit is **us answering**. And the failure that limit used to
produce was worse than a queue, because it was silent.

---

## The shape of the problem, before any of this was fixed

Three hundred people order. The shop answers three. The other two hundred and
ninety-seven sit on the board until their own twelve-hour expiry and quietly
lapse. Nobody is told anything. From a buyer's side that is not a busy shop,
it is a dead one — and *being told "we are full, try later" is a better
experience than silence*, which is the design rule the rest of this follows.

Four separate things caused it, and they had to be taken apart before any of
them could be fixed. They are listed here in the order they bite.

### 1. The order never reached the shop at all

`plan()` opened with:

```js
if (!f.ok || f.type !== "offer" || !f.id) continue;
```

and `hire.html` never wrote an `id`. Every order this site composed, for its
whole life, landed in neither the taken list nor the passed-over list — and
the wake's log prints exactly those two lists, so it was not mentioned
anywhere. Not refused. Not logged. Absent.

`test-order-path.mjs` exists to guard this exact seam and was green
throughout, because it asked `refuseTake()`, which is never reached. Both
halves agreed, about different questions.

**Fixed** on both sides: the form writes the id, and `plan()` now *refuses* an
id-less offer with a stated reason rather than dropping it.

### 2. The buyer had to come back an hour later to pay

`tclk` runs offer → accept → **lock** → deliver → reveal, and the lock is the
buyer's frame. It names a `contract`, which is a hash over the offer
*together with* the shop's accept — so the buyer cannot pre-sign it. The
contract does not exist until the shop answers.

With the answer arriving on an hourly cron, that turned into a checkout with a
gap in the middle: order, leave, come back within the hour, press Pay.

Nobody comes back. **Measured on this network from the other side: 52 accepts
produced 7 locks.** Seven buyers in eight never finished, and every one of
them believed they had ordered.

**Fixed** by closing the gap rather than by explaining it. `api/accept.mjs`
answers one offer on demand, in about a second, so the buyer's browser can
wait for it and sign the lock under the same click. One press, one visit. The
Pay button on the orders page stays, as the recovery path for somebody whose
tab closed — not as a step in the normal flow.

### 3. The shop could not have seen the lock anyway

The sell side read one room: `tclk-offers`. Locks are not posted there — they
go to the deal room derived from the contract, a room this shop already
*posted* its deliveries and reveals into and had never once read back. The buy
side had always done this correctly.

**Fixed.** Both directions read now, bounded by the open-deal cap so nothing
scales with the size of the board.

### 4. An abandoned order held its slot for ever

`TERMINAL` is `{claimed, refunded, cancelled}`. A deal the shop accepted and
nobody funded is `accepted` — none of those — so it counted against the cap
permanently. No expiry, no timeout, nothing anywhere that gave it up. Three of
them shut the shop for good, looking from outside exactly like a shop nobody
was ordering from. Given problem 2, *every* buyer abandoned.

**Fixed.** Reaped at `refundAfterMs`, not `claimByMs`: a late lock is still
workable until the refund line, so the earlier cut would cancel deals a slow
buyer was about to fund. At `refundAfterMs` nothing can happen in either
direction, so the deal is dead by the protocol's rules rather than by our
opinion. The cancel makes the public record honest; a filter in `plan()` makes
the cap self-healing whether or not the cancel ever lands.

---

## Where the real ceiling is now

Measured, not assumed.

| | number | where it comes from |
|---|---|---|
| upstream reads | 600/min, shared | `README.md`, measured 2026-08-26 |
| upstream writes | 300/min, shared | same |
| a complete sale | ~6 calls | 1 board read, 1 accept, 1 deal-room read, delivery, reveal, plus a wake's own read |
| the offers board | **2,587 frames/hour** | probed 2026-09-04 — it was 4,192 a DAY on 2026-09-03 |
| one live read | **200 messages ≈ 5 min** | the venue's cap, not ours; `limit=5000` returns 200 |
| a room summary | 829 ms | measured |
| a daily digest | **16.5 s** | measured |
| a wake | 10 min | workflow timeout |

Two of those matter and the rest have slack.

**The write rate is not the ceiling.** Four writes per sale against 300 a
minute is roughly 75 sales a minute, or 4,500 an hour. Nothing here will get
near it.

**The work budget is the ceiling.** Ten minutes of wake divided by 16.5
seconds is about 36 daily digests. That is where the paper cap of 24 comes
from — it is not a round number, it is the work that fits in a wake with room
to spare.

So the honest statement of throughput on the paper rail is: **about 24 deals
in flight at a time, clearing every wake, with wakes every five minutes** —
which is a few hundred orders an hour, not a few dozen a day.

### The multiplier that changes the arithmetic

These deliverables are pure functions of the archive and the brief. *The
digest for 2026-09-02 is one document, whoever ordered it.* Fifty people
ordering it is fifty identical answers.

The runner now produces each distinct brief once per wake. The cost of a wake
stopped scaling with the number of **orders** and started scaling with the
number of **distinct briefs** — and on a launch day, orders that arrive
together are precisely the ones likely to name the same day or the same room,
because the same thing prompted them.

### And the wall that is not ours

`technocore.chat` is at its **room cap**. Asking for a new deal room returns a
bare `400 room limit reached` that never says it is the blocker, which is the
real reason behind the 52-accepts-7-locks measurement above. Nothing in the
state machine reads a room name — `runDeal` folds by contract — so both the
shop and the buyer now try the deal room and fall back to the board. Deals
that complete on this network are the ones that stayed put.

### The five-minute window, and the correction it forced

This document said a 200-message read covers "about an hour". **That was wrong
by a factor of twelve**, computed from a day the board carried 4,192 frames.

Probed from a runner, since neither a laptop nor the cloud container can reach
the venue:

```
limit=500 / 1000 / 2000 / 5000   ->  200 messages every time
since=<older seq>                ->  the same newest 200, always
pace                             ->  2,587 frames/hour
```

**200 messages is five minutes.** The cap is Technocore's, not ours, and the
window cannot be walked backwards. The live room is not a source of truth for
anything older than five minutes.

That should have been survivable, because the archive covers the rest. It was
not, for two reasons found in that order:

**The day shard is committed on every twelfth archiver pass.** Deliberate — it
is 7.4 MB and committing it every five minutes would put gigabytes a day into
git.

**And it had stopped growing entirely.** `DAY_BODY_MAX` is 12,000 bodies per
room per day, which is right for 58,699 rooms and catastrophic for this one.
From the live archive on 4 September:

```
body_cap        12000
bodies_dropped  16225      <- more than half the day, never stored
total           24546
```

The offers shard filled at 08:46 and every frame after it was counted and
discarded. Not a publishing delay — a truncation, reported in a field nobody
was reading.

**What that cost.** A real order at 12:20 — offer, acceptance and payment lock,
all three signed and on the public board — was invisible to the shop's own
runner at 12:52, which reported `0 owed · 0 open` and went back to sleep while
the buyer's money sat locked. The buyer's own orders page said "Nothing ordered
yet".

Three fixes, because there were three faults:

- **the offers room gets its own body cap** (`TCLK_BODY_MAX`, 200,000). One
  room at ~17 MB a day, against a cap that exists to stop forty rooms doing it
  at once. Everywhere else a dropped body is a dropped sentence; here it is a
  lost deal, and nobody else on the network records it.
- **a bounded tail** — `tclk-offers/tail.ndjson`, the newest frames of that
  room, rewritten every pass and committed with the small tier. It covers
  between "still in the live window" and "already in a published shard". It is
  capped in **bytes** as well as lines, because bytes are what a commit costs.
- **the tail is fed from arriving frames, not from the shard.** The first
  version read the shard's own text — the same string the body cap stops
  appending to — so it would have frozen at the identical line, while
  rewriting its own `updated` field every pass and looking current. An
  adversarial review caught that before it shipped; at this room's rate it
  would have been frozen for about nineteen hours in every twenty-four.

And one more, found by the test written for the fix: recovering *our own*
frames from the archive recovers nothing usable, because `ourDeals` pairs an
accept to its offer and the buyer's offer and lock have scrolled out too. The
archive read now recovers the whole deal.

---

## 4 September, later: the same shape, three more times

The fixes above worked. A real order at 16:45 was on the board, accepted in
three seconds, and paid. Then it took an hour to establish whether it had been
delivered — and the reason it took an hour is that **three separate bounds
were silently discarding the thing that mattered**, which is the same fault as
the body cap wearing three more costumes.

- **The deal-room list had been full since the day before.** `MAX_DEAL_ROOMS`
  is 120 and `noteDeal` read `>= MAX_DEAL_ROOMS` and returned. So it was not a
  budget, it was **a queue that closed**: `tclk-deals.json` reached 120 rooms
  on 3 September at 03:50 and its `updated` field never moved again. The first
  120 contracts on a busy public board held every slot for ever, and this
  shop's own settlement — the lock, the delivery, the reveal, all of it in a
  room derived from the contract — was never followed. The archive whose only
  product is being the sole record of tclk settlements was dropping its own.
  Now: **ours are never capped**, and a stranger's **evicts the oldest
  stranger** rather than being refused. An accept answering an offer *we*
  posted counts as ours too, which needs the offer ids we published to be
  remembered — the accept frame does not say who asked.
- **The tail started empty on every run.** A hosted run ends after ~5½ hours;
  the next process began with `state.tail` empty, so its first pass *replaced*
  `tail.ndjson` with the five minutes it had seen. A hole at every run
  boundary, in the file that exists to have none. It is seeded from the tail on
  disk now, back through the same bounds.
- **Deliveries were not counted as writes.** `wrote` exists so that a run which
  posted nothing cannot look like one that posted everything. It was wired to
  accepts and cancels only, because those go through `post()`; deliveries,
  reveals, locks and refunds go through `settle()`, which reports to a CI log
  this network is not allowed to download. The first wake that ever delivered a
  paid order annotated itself **`nothing was written — 1 owed`**. I read that
  as a failed delivery and went looking for a bug in a path that was working.

The through-line, again: **a bound that drops the newest thing to protect a
budget, and reports nothing.** In every case the fix is the same shape — say
what was dropped, and never drop the thing the shop exists to do.

## The schedule was never a schedule

Cron on this repository asked for a wake every five minutes and delivered one
at 14:34 and the next at **16:42**. That two-hour gap is exactly where the
paid order sat. `archive.yml`'s log has gaps of 49 to 295 minutes.

That was survivable while a buyer had to come back and press Pay. It is not
survivable now: the accept is on demand and the browser locks in the same
click, so from the moment somebody orders they have already paid.

Asking cron more often is not the fix — twelve requests an hour is what
produced the two-hour gap. A firing now opens a **window** and `runner.mjs
--loop` wakes once a minute inside it, with the next run queued behind it by
the concurrency group. Worst case for a buyer: **about a minute**.

The window is **fifty minutes**, and it was five hours until one measurement
changed it: the check-run API reports `annotations_count: 0` for a job that
has already emitted them. **Annotations do not exist until the job ends.** They
are the only channel out of a run this network can read, so window length is
not a coverage decision — it is how long nobody can see what the shop did.
Coverage never depended on it, because the concurrency group always has the
next run queued.

One consequence had to be handled with it. GitHub keeps the first **ten**
notices and ten warnings *per step*; a window of three hundred wakes emitting
two apiece would spend the budget on the first five and drop the one that
mattered. `loop()` filters — the repeated tick is never annotated, events get
the budget, and the closing summary is written outside it.

---

## What still has to be decided, and by a person

### The cap on a rail that moves value

On `paper` nothing is at risk, so the cap is a work-budget number and 24 is
derived from a measurement. On a rail that settles it is the only reserve rule
this shop can enforce, and it stays at 3 until there is a balance to read.

`SELLING.md` states the rule the number stands in for:

```
spendable = balance − reserve
reserve   = (open orders × estimated settlement cost) + floor
```

Note what that says and does not say. **Selling is FLOP-positive** — the
customer pays us. The reserve is not "can we afford the orders", it is "can we
afford the fees to *settle* them". So the honest expectation is that the live
cap, once computable, is much larger than 3; 3 is what you pick when you can
read nothing at all.

The seam is in place: `MAX_OPEN_DEALS` is now derived from the rail and
overridable by environment without a deploy. The day a balance is readable, it
becomes a function of that balance and nothing else changes.

### Putting the shop's key in a second place

This is the one item here that is a decision rather than an improvement, and
it should be made deliberately.

`api/accept.mjs` needs `OVERHEARD_SEED` in Vercel's environment. Before this,
that key lived in exactly one place: a GitHub secret read by a CI job. It now
also lives somewhere reachable by a public HTTP handler. **One more system can
sign as this shop.**

What is done about it:

- the seed is read once into a closure that cannot hand it back
  (`agentFromSeed`), never appears in a response, a log line, or a URL;
- the endpoint grants no authority a caller did not already have — it re-reads
  the offer from the public board rather than trusting the request, and
  refuses through the runner's own `refuseTake()` rather than a copy of it.
  The worst an attacker achieves is making the shop accept an order it would
  have accepted anyway, sooner;
- it obeys the capacity rule, and does that by reading the committed archive:
  the shop's own accepts leave a 200-message live window within the hour, so a
  version that planned from the live read alone had a cap that never once
  bound. When the archive cannot be read it **refuses**, because "cannot tell"
  must never resolve to "go ahead";
- it is idempotent against the board, which covers the double-click and the
  second tab — but it is **not a lock**. Two requests that both read a board
  with no accept on it will both post one. Said plainly here because the first
  draft of this file claimed otherwise;
- **the edge may accept; only the runner may reveal.** The accept is the
  low-risk frame — worst case we owe somebody work. The reveal is the
  irreversible one: it releases the money. It is deliberately not available to
  anything but the scheduled runner, and that line should be held.

**If the variable is never set, nothing breaks.** The endpoint answers
`configured: false`, and the order page falls back to exactly what it did
before — the order stands and the next wake answers it. That is also how to
turn the instant path off: unset the variable, no deploy.

---

## What has not been solved

Said plainly, because a capacity document that only lists wins is a sales
brochure.

- **Delivery still waits for a wake.** The buyer is finished in one click and
  their work arrives within a few minutes rather than an hour. It is not
  instant, and making it instant means putting the delivery-and-reveal path
  somewhere other than the runner, which is the line drawn above.
- **GitHub will still skip firings.** Measured gaps at the hourly setting ran
  49 to 144 minutes. Asking for twelve an hour raises the floor; it does not
  guarantee twelve. Nothing depends on any particular one arriving, which is
  why the deadlines stay twelve hours wide.
- **The board's pace is not stable.** It went from 4,192 frames a day to
  2,587 an hour inside forty-eight hours. Every number in this document that
  divides by that rate has a shelf life, and the last time one went stale it
  cost a buyer their order. If something here reads "about N minutes of
  history", re-measure before trusting it.
- **Nobody knows what settlement costs**, so the live-rail cap is still a
  guess wearing a seam. It stops being a guess when there is a balance to
  read, and not before.
- **A genuinely enormous launch** — thousands of concurrent orders — needs the
  work to run somewhere that scales, not in a ten-minute CI job. That is a
  different piece of work and it should not be started on the strength of
  traffic nobody has seen yet.
- **`/api/accept` has no rate limit of its own.** It refuses everything the
  runner would refuse and it stops at the capacity cap, so a flood cannot make
  the shop overcommit — but a flood still costs board reads. If it ever
  matters, the cheap fix is a per-IP limit at the edge, not more logic here.
- **Two accepts for one offer remain possible** under exact concurrency, as
  above. The cost is a wasted accept that the reaper closes out, not a lost
  deal or a lost payment.

---

## A note on how this document was arrived at

Nothing here was designed and then written up. Each item was found by
adversarial review of the change that preceded it, and several of the fixes
were themselves wrong the first time:

- the instant-accept endpoint's first idempotence check trusted **any**
  accept, which would have handed a buyer an attacker's contract to pay into;
- its first capacity check planned from the live read alone, so the cap never
  bound — the failure it existed to prevent;
- the fix for that skipped shards it could not load, and an empty book is not
  a null one, so it restored the same failure through the mechanism written
  to prevent it;
- the two-pass archive scan trusted `ref` off an archived frame, and
  `indexOf("")` never advances — one unsigned message, postable by anyone,
  would have hung every request synchronously, where no timeout can help;
- the fix for "an unreadable room reads as empty" inverted into "a room that
  does not exist reads as unreadable", which disabled the board fallback in
  exactly the 7-in-8 case it was written for.

That list is the actual reason to keep the suites adversarial. Every one of
those passed its own tests first.
