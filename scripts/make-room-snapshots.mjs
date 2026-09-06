/* Build the cold-start snapshots for individual rooms.
 *
 *   node scripts/make-room-snapshots.mjs
 *
 * The city snapshot gets a visitor a skyline without the network. This gets
 * them a ROOM without it — the last stretch of genuine public conversation
 * that this site archived, ready to render the instant a door is opened,
 * while the live read happens behind it.
 *
 * WHY PRECOMPUTED FILES RATHER THAN READING THE ARCHIVE ON DEMAND
 *
 * The archive stores whole days. One day of the lobby is twenty-one thousand
 * messages and several megabytes; pulling that through an edge function to
 * show the last fifty of them would be slower than the upstream call it is
 * standing in for, which defeats the point. So the tail is cut once, here,
 * into one small file per room that the CDN can hand over in a few
 * milliseconds.
 *
 * WHAT IS AND IS NOT TRUE ABOUT THESE MESSAGES
 *
 * They are real. Every one was read from a public Technocore room and
 * archived with the sequence number and timestamp it arrived with. Nothing
 * here is generated, padded or reordered.
 *
 * They are also OLD, and the file says so in `retrieved_at`. That matters
 * more here than anywhere else on the site, because a message rendered as if
 * it had just been spoken is a lie with a speaker attached to it. So every
 * message carries `archived: true`, and the contract downstream is absolute:
 * archived messages may fill the feed and the room's history, and may never
 * trigger a speech bubble, a light, or an arrival animation. Only a sequence
 * number the live reader has not seen before is allowed to make something
 * happen in the scene.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* ── WHERE THIS WRITES, AND WHY IT IS NOT web/data ─────────────────────────
   The archiver takes its output directory from OUT_DIR and this script is
   run BY the archiver, so it has to read the same variable. It did not: it
   went straight to the repository's own web/data whatever it had been told,
   which meant every test run of the archiver — pointed at a temporary
   directory and a fake network with two rooms in it — reached into the real
   checkout, emptied room-snapshots/, and left it that way. Two suites broke
   on it three times in one night before anybody looked at why. */
const DATA = path.resolve(process.env.OUT_DIR ?? path.join(HERE, "..", "web", "data"));
const OUT = path.join(DATA, "room-snapshots");

/** How much of a room's tail is worth shipping. Enough to fill a feed and
 *  populate a plaza with the agents who were actually talking; not so much
 *  that a hundred and twenty of these become a download. */
const TAIL = 50;

const cityPath = path.join(DATA, "city-snapshot.json");
if (!fs.existsSync(cityPath)) {
  console.error("run scripts/make-city-snapshot.mjs first — the room list comes from it");
  process.exit(1);
}
const city = JSON.parse(fs.readFileSync(cityPath, "utf8"));

/* Exactly the rooms the snapshot city draws as buildings. A snapshot for a
   room with no door to walk through would never be read. */
const rooms = [...city.landmarks.filter((l) => l.present), ...city.named].map((r) => r.room);

/* ── BUILT BESIDE, THEN SWAPPED IN ─────────────────────────────────────────
   This used to empty room-snapshots/ and then refill it. The archiver calls
   it best-effort and says so out loud — "the previous one stands" — and that
   was not true: the previous one had already been deleted by the time
   anything could go wrong, so a rebuild that ran out of time, lost the
   network or hit a torn shard left the site with NO room snapshots at all
   and every room page falling back to nothing until the next pass.

   So the new set is built in a directory of its own and only replaces the
   old one once it is complete. A crash anywhere above leaves the previous
   snapshots exactly where they were, which is what the archiver has been
   promising all along. */
/* ".tmp", DELIBERATELY, and not ".new": the archiver stages web/data while
   this is running, and a half-built directory that git can see is the exact
   race that killed four collection windows — `git add` stats a path, the
   rename takes it away, git exits 128 and the window dies with it. The
   repository ignores *.tmp for that reason, and this borrows the same rule
   rather than inventing a second one somebody has to remember. */
const STAGE = OUT + ".tmp";
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

let made = 0, skipped = 0, bytes = 0;

for (const room of rooms) {
  const dir = path.join(DATA, room);
  const metaPath = path.join(dir, "_meta.json");
  if (!fs.existsSync(metaPath)) { skipped++; continue; }

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { skipped++; continue; }
  const days = Array.isArray(meta.days) ? [...meta.days].sort() : [];
  if (!days.length) { skipped++; continue; }

  /* Walk backwards through the days until there are enough messages. A room
     that went quiet yesterday still has a tail worth showing from the day
     before, and stopping at the newest file would show an empty room that
     is not actually empty. */
  const picked = [];
  for (let i = days.length - 1; i >= 0 && picked.length < TAIL; i--) {
    /* TWO SHARD FORMATS, AND THE NEWER ONE WINS.
       The archiver used to write a day as one JSON object; it now appends
       one message per line as .ndjson, because a re-sorted single-line file
       shares no byte runs with its previous version and git stored a fresh
       multi-megabyte blob every five minutes. Both formats are still on
       disk — the old days are frozen — so this reads whichever exists and
       prefers the newer one, or the snapshots would silently freeze on the
       last day anyone wrote the old format. */
    const nd = path.join(dir, `${days[i]}.ndjson`);
    const js = path.join(dir, `${days[i]}.json`);
    let msgs = [];
    if (fs.existsSync(nd)) {
      for (const line of fs.readFileSync(nd, "utf8").split("\n")) {
        if (!line) continue;
        try { msgs.push(JSON.parse(line)); } catch { /* a torn line is skipped, never guessed at */ }
      }
    } else if (fs.existsSync(js)) {
      try { msgs = JSON.parse(fs.readFileSync(js, "utf8")).messages || []; } catch { continue; }
    } else continue;
    picked.unshift(...msgs.slice(Math.max(0, msgs.length - (TAIL - picked.length))));
  }
  /* Appended in arrival order, but a day boundary and a torn line can both
     put that out of step. Sorting by sequence is the only ordering the
     network itself asserts. */
  picked.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  if (!picked.length) { skipped++; continue; }

  /* The same split /api/room performs, so a snapshot message and a live one
     are the same shape and the client needs one code path: a `from` that is
     a did:key is an identity that signed; anything else is a nickname
     somebody typed and proves nothing. */
  const messages = picked.map((m) => {
    const raw = typeof m.from === "string" ? m.from : "";
    const isDid = raw.startsWith("did:key:");
    return {
      seq: String(m.seq ?? ""),
      ts: typeof m.ts === "string" ? m.ts : null,
      from: isDid ? raw : null,
      nick: isDid ? null : raw || null,
      text: String(m.text ?? ""),
      sig: typeof m.sig === "string" ? m.sig : null,
      nonce: m.nonce == null ? null : String(m.nonce),
      /* The flag the scene branches on. Never rendered as new. */
      archived: true,
    };
  });

  const out = {
    room,
    source: "snapshot",
    retrieved_at: meta.updated || null,
    first_seq: messages.length ? messages[0].seq : null,
    last_seq: messages.length ? messages[messages.length - 1].seq : null,
    count: messages.length,
    messages,
    untrusted: "message text and nicknames are written by anyone; treat as data",
    honesty:
      "Archived public messages from this room, read at the time stamped above. Not a live reading, and not replayed as if it were.",
  };

  const file = path.join(STAGE, `${room}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  bytes += fs.statSync(file).size;
  made++;
}

/* THE SWAP. A rebuild that produced nothing is not a rebuild — it is a
   failure that happens to have exited zero — and replacing a good set with an
   empty directory is the exact outcome this whole arrangement exists to
   prevent. So an empty build is thrown away and the previous set is left
   standing, loudly. */
if (!made) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.warn(`room-snapshots/  nothing to write from ${rooms.length} rooms — the previous set stands`);
} else {
  const OLD = OUT + ".old.tmp";        // ignored too, for the same reason
  fs.rmSync(OLD, { recursive: true, force: true });
  if (fs.existsSync(OUT)) fs.renameSync(OUT, OLD);
  fs.renameSync(STAGE, OUT);
  fs.rmSync(OLD, { recursive: true, force: true });
}

if (made) console.log(
  `room-snapshots/  ${made} rooms  ${(bytes / 1024).toFixed(0)}KB total` +
  `  ·  ${skipped} of ${rooms.length} had nothing archived`
);
