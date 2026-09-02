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
