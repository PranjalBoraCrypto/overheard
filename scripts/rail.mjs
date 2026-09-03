/**
 * Which settlement rail this shop uses, in one place.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS ONE CONSTANT AND A LOT OF PROSE
 *
 * A tclk deal names a rail: the thing that actually holds the money while the
 * lock is unopened. Today that is `paper`, which holds nothing. It is a
 * rehearsal rail — real signed frames, a real state machine, and no value
 * moving anywhere — and almost the whole live board runs on it because the
 * FLOP testnet has not opened.
 *
 * The rail was previously written out four times: the offers we post, the
 * locks we send, the shelf constant in the runner, and the sample offer on the
 * deals page. That is fine until the day it changes, and on that day it is
 * exactly the shape of bug that gets fixed in three places and missed in the
 * fourth — leaving us posting offers on a live rail and locking on a dead one,
 * or advertising terms we do not honour. Nothing would fail loudly. The deals
 * would just quietly not settle.
 *
 * So: one constant, imported everywhere, and a test that no other file spells
 * the rail out for itself.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT TESTNET DAY LOOKS LIKE
 *
 * Change RAIL here. That is the whole rail change.
 *
 * It is deliberately NOT everything, and the rest cannot be pre-built without
 * guessing:
 *
 *   · A PAYMENT KEY. A rail that holds value needs to know where value goes.
 *     The tclk spec does not define that field's shape for flop-htlc, because
 *     flop-htlc does not exist yet — the spec says plainly that no rail holds
 *     value. Inventing a shape now produces code that looks finished, cannot
 *     be tested against anything, and is wrong in a way no test can catch.
 *     It goes in when there is something real to point at.
 *
 *   · WHAT IT COSTS. Nobody can say what locking or claiming costs on a rail
 *     that has not shipped, so the reserve rule stays "cap how many deals are
 *     open at once" rather than a FLOP figure we cannot check.
 *
 * The honest position is that switching rails is one line, and being READY to
 * switch is not the same as being able to settle. This file makes the first
 * true so the second is the only thing left to argue about.
 */

/** The rail every frame this shop signs will name. */
export const RAIL = process.env.TCLK_RAIL ?? "paper";

/** The rails we advertise on an offer. One today; a list because the frame
 *  format takes a list and a shop may one day accept more than one. */
export const RAILS = [RAIL];

/** Rails we are willing to ACCEPT from a stranger's offer. Same set as the
 *  ones we post, and deliberately not "anything" — accepting a rail we cannot
 *  settle on is promising a claim we cannot make. */
export const RAILS_WE_TAKE = new Set(RAILS);

/** True while the rail moves no value. The page and the job briefs say so
 *  outright rather than letting a buyer assume otherwise, and this is the one
 *  place that decides whether that sentence is still true. */
export const IS_REHEARSAL = RAIL === "paper";
