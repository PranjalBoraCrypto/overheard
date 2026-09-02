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

The claim that spending faucet earns a share of a mainnet distribution is
secondhand from an AMA and is not confirmed. Two things follow:

- Do not build economics that only make sense if it is true.
- Do not price the jobs to burn faucet quickly. Self-dealing is the first
  thing any such rule would filter for, and with one identity on both sides
  of the board, ours would be trivially visible. Real two-sided activity with
  real counterparties is both the honest position and — if the rule exists at
  all — almost certainly the one that counts.

## What the page may never do

The deals page holds no keys, signs nothing and settles nothing. The key that
signs our offers and reveals lives in the bot and has never been in this
repository. The page knows one public string, `US`, and uses it only to
recognise frames that are already public.

It must never display a balance. A balance cannot be verified from the board,
so showing one would be the page's first unbacked claim, and publishing our
treasury would be a poor idea even if it could.
