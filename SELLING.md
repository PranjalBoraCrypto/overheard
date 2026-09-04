# Selling work on the board

Overheard advertises four jobs on `tclk-offers` and does them for FLOP. This
is the operating rule for the bot that will run them. None of it is code yet;
it is written down first because the decisions are cheap now and expensive
after the first order.

## Which way the money moves

In all four jobs Overheard is the **payee**. The customer is the payer: they
lock, we deliver, we reveal, we claim. Selling is FLOP-positive. Nothing we
sell is fulfilled by buying work from another agent — the jobs are answered
from the archive and from compute, neither of which is bought with FLOP.

So the balance cannot be drained by selling. It can only be drained by two
things, and they are worth keeping apart in your head:

1. **Settlement cost.** If claiming a `flop-htlc` lock costs anything, the
   claimer pays it, and the claimer is us. Unknown at the time of writing:
   almost the whole board still settles on `paper`, which moves nothing.
   Assume it is not zero until it is known to be.
2. **Us choosing to be the payer.** Buying work from other agents to spend
   the faucet. That is a decision, not a requirement of running the shop.

## The reserve floor

We use one identity for both sides, so the fence between "money we can spend"
and "money we must keep" is a rule rather than a second wallet. The bot must
honour it:

    spendable = balance − reserve
    reserve   = (open orders × estimated settlement cost) + floor

- **Never accept an order that would push the reserve below what the orders
  already accepted cost to settle.** Refusing an order is free. Accepting one
  we cannot settle wastes the customer's time and our name, and the customer
  gets their money back anyway — so the only thing we can actually lose here
  is reputation, which is the expensive one.
- **Never spend as payer out of the reserve.** The spend budget is whatever
  is left above it, and it is allowed to reach zero. Reaching zero must stop
  us buying; it must never stop us delivering.
- **The floor is not an optimisation.** It exists so that a surprise — a fee
  higher than estimated, a rail change, a run of orders arriving together —
  cannot leave a paid-for job unsettled.

## What happens when we cannot take work

Nothing dramatic, and nothing dishonest. We stop posting offers. The ones
already on the board lapse at their own `expiresMs`, the deals page stops
finding them, and the gig cards go back to saying we are not open. There is
no status file to update and no banner to write, because the page reports
what is on the board rather than what we tell it.

An order already accepted is safe either way: if we cannot deliver it, we
never reveal, and the lock refunds itself at the customer's deadline. That is
the protocol doing its job, not a policy we could get wrong.

## On spending to qualify for anything

**Updated 3 September.** This section used to open "the claim is secondhand
from an AMA and is not confirmed". It is no longer secondhand. Arthur Hayes,
quote-tweeting Flop Labs: *"We will reward true agentic commerce using this
feature with airdrop FLOP tokens. Agentic economic swarms that use FLOP for
commerce is the future. Start today on Technocore.chat"*.

So the premise is public and attributed. What remains unconfirmed is every
number attached to it — the size, the formula, the ratio, whether spend or
settled deals or counterparties is what gets counted. Nobody outside Flop Labs
knows, and anybody who says they do is guessing.

**The owner's stated position** is that this is worth spending into: testnet
FLOP comes from a faucet and costs nothing, so burning three of it for one
mainnet token is a trade worth making. That is a reasonable bet on his own
money and this document records it as the objective rather than arguing with
it. It changes what the shop optimises for once a real rail exists: **the buy
side stops being the quieter half and becomes the point.**

What it does NOT change, and this matters more now rather than less:

- **No self-dealing.** One identity on both sides of the board is the first
  thing any rule would filter for, and with a single DID ours would be
  trivially visible. It would also be the exact opposite of "true agentic
  commerce" — the phrase does the work in that sentence.
- **No buying junk to move the number.** A deal that settles because we paid
  for something worthless is volume, not commerce. If the rule is any good it
  will not count; if it is not, we have still spent the day teaching our own
  shop to lie about what it bought.
- **Nothing gets posted we cannot honour.** Volume that lapses is worse than
  no volume: a lapse is a lapse whether or not value moved, and it is on the
  public record under our DID for as long as the archive exists.

**The knobs, when the rail is real.** These are tuned for caution today and
are the levers that change, in one place each:

| | today | why it is low |
|---|---|---|
| `MAX_OPEN_BUYS` | 2 | we could not read a balance, so we capped count instead |
| `WANTS` | 2 jobs | both things we genuinely want and can check the answer to |
| `BUY_WINDOW` | 24h / 48h | a stranger needs time to read, work and post |
| `MAX_OPEN_DEALS` | 24 on `paper`, 3 otherwise | it stopped being one number — see below |

Raising them is a decision to take deliberately once we can read a FLOP
balance and know what locking costs — not before. Until the balance is
readable, "how many deals are open at once" is the only reserve rule that is
checkable, and an unreadable reserve figure would be a decoration.

**Except that one of them was wrong in both directions at once.**
`MAX_OPEN_DEALS` was 3 on every rail. On a rail that settles, that is the
cautious number this table describes and it stays. On `paper` nothing is at
risk — the rail holds no value — so the cap protected no money and was
quietly capping a rehearsal at roughly 36 orders a day for the sake of a
reserve that does not exist.

What actually bounds a wake on `paper` is the WORK. Measured: a room summary
takes 829 ms and a daily digest takes 16.5 seconds, against a ten-minute
workflow timeout. Twenty-four is that budget with room to spare — a
measurement, not a round number.

Two things follow, and they belong in this file because they change what the
reserve rule will look like when it becomes real:

- The cap is now DERIVED from the rail, and overridable by environment
  without a deploy. The day a balance is readable it becomes a function of
  that balance and nothing else has to move.
- **Selling is FLOP-positive**, as the top of this document says. So the
  reserve is not "can we afford these orders" — the customer pays us — it is
  "can we afford the FEES to settle them". The honest expectation is that the
  live cap, once computable, is considerably larger than 3. Three is the
  number you choose when you can read nothing at all.

**Since acted on.** The cap is **50 on every rail**, and the rail no longer
changes it, because what differed between the rails was the money argument and
the money argument was wrong on this side of the book. Three constraints
remain, none of them a balance:

| what binds | at 50 | ceiling |
|---|---|---|
| reads — `1 + 2n` per wake, a wake a minute | ~101/min | 600/min documented |
| time — a daily digest is 16.5s, a summary 0.8s | ≤14 min a wake | the 50-minute window |
| the claim fee, which we have never paid | unknown | the reason it is 50 and not 300 |

It is an env var, so it moves in one field during an incident. It goes up when
a real testnet day has been watched rather than reasoned about.

`CAPACITY.md` has the whole analysis, including what happens on a launch day.

**The one honest thing to keep saying:** we do not know the ratio. Three-for-
one is the owner's bet, not a modelled number, and this file should not start
pretending otherwise the moment somebody quotes it back.

## What the page may never do

The deals page holds no keys, signs nothing and settles nothing. The key that
signs our offers and reveals lives in the bot and has never been in this
repository. The page knows one public string, `US`, and uses it only to
recognise frames that are already public.

It must never display a balance. A balance cannot be verified from the board,
so showing one would be the page's first unbacked claim, and publishing our
treasury would be a poor idea even if it could.
