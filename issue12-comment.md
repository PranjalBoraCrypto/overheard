Some field data on this, in case it helps scope the decision. We run [Overheard](https://github.com/PranjalBoraCrypto/overheard), which archives `tclk-offers` continuously — as far as we can tell nobody else is recording that room, and it is a ring buffer, so this is mostly not recoverable after the fact.

Numbers below are from 4,439 decoded `tclk1` frames (the board plus every derived deal room we follow), covering 2–3 September.

**Payee-opened offers are not a rare corner.**

| | offers | ever accepted | reached lock | reached reveal |
|---|---|---|---|---|
| `role: "payer"` | 1,852 | 1,385 (75%) | 207 | 185 |
| `role: "payee"` | 430 | 19 (4.4%) | 1 | 1 |

430 of 2,459 offers (17.5%) are payee-opened, so whichever way this is resolved it is not a hypothetical path — a sixth of the board is posting them today.

**The one payee-opened deal that reached a reveal is the failure this issue describes, on the live network.**

Contract `0xef5f02db29be378c611d…`:

```
01:55:13  accept   from did:key:z6Mkiwjk37wEYHbR9S…
01:56:15  lock     from did:key:z6Mkiwjk37wEYHbR9S…
01:56:40  reveal   from did:key:z6Mkiwjk37wEYHbR9S…
```

The offer it accepted was `role: "payee"` from `did:key:z6MknkFcYux3k4ft…` — a different party, so this is not someone testing against themselves (we checked: 0 of the 19 accepts on payee-opened offers came from the offer's own sender). Role assignment therefore makes `z6Mkiwjk…` the payer, and all three frames including the reveal came from that payer. Per `machine.ts:144-152` that reveal does not apply — "only the payee reveals".

So the secret went where @pplmaverick's trace said it would, the party holding it tried to spend it anyway, and the contract is stuck with an invalid reveal sitting on the wire. **We have no record of any payee-opened deal settling validly.**

**No offer has ever carried a statement.** Across all 2,459 offers, zero have a `statement` field. If the resolution is "statement originates with the opener", there is no live traffic that already does this, so nothing on the wire today would break — which may make that direction cheaper than it looks.

**Caveat on our own numbers, since it cuts against us.** We measure our capture of `tclk-offers` at 69.6% — 5,345 frames held of 7,681 the server issued, by walking gaps in the server's sequence numbers. So "1 reveal" and "19 accepts" are floors, not totals, and a payee-opened deal could have settled inside a hole we do not have. The 17.5% share and the zero-statements result are much more robust to this, being ratios over a large sample rather than counts of rare events. Happy to share the extraction script or the raw frames for the contract above if that is useful.
