/**
 * city/boot.js — Agent City, assembled.
 *
 * THE ORDER THINGS HAPPEN IN IS THE POINT.
 *
 *   1. Ask the machine what it can do, before importing anything heavy.
 *   2. If there is no WebGL, load the flat map instead — a different view of
 *      the same data, not an apology.
 *   3. Only then import three.js. Nothing above this line costs 170KB.
 *   4. Show the city from the directory, which arrives long before anybody
 *      has finished reading the headline.
 *   5. Poll a room only once somebody is standing in it.
 *
 * WHAT LIVES HERE: the wiring, the camera choreography, and the two overlays
 * that need to know where things are in 3D — the labels and the speech
 * bubbles. Everything else is in its own file: the truth in data.js, the
 * panels in ui.js, the scene in world.js, the feel in cam.js.
 */

import * as Q from "./quality.js";
import * as D from "./data.js";
import * as S from "./sound.js";
import { makeUI, ago } from "./ui.js";
import { makeDeclutter } from "./declutter.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function boot() {
  const stage = $("stage"), canvas = $("scene"), overlay = $("overlay");
  const els = {
    stage, overlay, chips: $("chips"), side: $("side"),
    hover: $("hover"), hits: $("hits"), status: $("status"), rail: $("rail"),
  };

  /* ── 1. what can this machine do ─────────────────────────────────────── */
  let { level, auto, why } = Q.guessLevel();
  const webgl = Q.hasWebGL();

  if (!webgl) {
    $("bootTitle").textContent = "Showing the flat map";
    $("bootWhy").textContent = "This browser has no WebGL, so Agent City is drawing the same live network in 2D. Everything except the 3D city is here.";
    const { mountFlat } = await import("./flat.js");
    canvas.hidden = true;
    return startFlat(mountFlat, els);
  }

  /* ── 2. the engine, and only now ─────────────────────────────────────── */
  $("bootWhy").textContent = "Loading the renderer.";
  let THREE;
  try {
    THREE = await import("/vendor/three.module.min.js");
  } catch {
    const { mountFlat } = await import("./flat.js");
    canvas.hidden = true;
    $("bootTitle").textContent = "Showing the flat map";
    $("bootWhy").textContent = "The 3D engine could not load. The same live network is drawn in 2D below.";
    return startFlat(mountFlat, els);
  }

  const { buildWorld, DISTRICTS } = await import("./world.js");
  const { makeCamera } = await import("./cam.js");

  let preset = { ...Q.PRESETS[level] };
  let world = buildWorld(THREE, { canvas, preset, reduced });
  let cam = makeCamera(THREE, world.camera, canvas, { reduced });

  /* ── THE SECOND SCENE ────────────────────────────────────────────────────
     A room is a place now, not a closer camera. It has its own THREE.Scene,
     its own camera and its own camera limits — a sixty-unit plaza cannot be
     framed by numbers chosen for a three-hundred-unit skyline — and it
     shares only the renderer and the canvas with the city.

     Two consequences are the point of doing it this way. The city is left
     standing exactly as it was while somebody is inside a room, so coming
     back is a restoration and not a rebuild. And the room is free to look
     like somewhere else, which is the whole complaint the old version could
     not answer: it was the same city, from nearer.

     Built on first entry, never at boot. Most visits to this page never open
     a room, and a scene nobody asked for is bytes and memory spent on
     nothing. */
  let room3d = null, roomCam = null;
  let mode = "city";                     // "city" | "room"
  let camSaved = null;                   // where the visitor was standing

  async function ensureRoomScene() {
    if (room3d) return room3d;
    const { makeRoom, ROOM_LIMITS } = await import("./room3d.js");
    room3d = makeRoom(THREE, { renderer: world.renderer, preset, level: preset.tier, reduced });
    roomCam = makeCamera(THREE, room3d.camera, canvas, { reduced, limits: ROOM_LIMITS });
    roomCam.enabled = false;
    const { makeTransmit } = await import("./transmit.js");
    tx = makeTransmit(overlay, {
      open: (key, agentId) => { if (key) selectMessage(key); else if (agentId) selectAgent(agentId); },
    }, reduced);
    const r = canvas.getBoundingClientRect();
    room3d.resize(r.width, r.height);
    roomCam.setAspect?.(r.width / r.height);
    tx.resize(r.width, r.height);
    fitTx();
    return room3d;
  }

  /** The crossfade. A cut between two 3D scenes reads as a bug; a short fade
   *  reads as a door. 280ms, and skipped entirely for reduced motion. */
  function veil(then) {
    const v = $("veil");
    if (reduced || !v) { then(); return; }
    v.classList.add("on");
    setTimeout(() => { then(); v.classList.remove("on"); }, 280);
  }

  /* ── 3. state ────────────────────────────────────────────────────────── */
  const st = {
    room: null,            // the room we are standing in
    agentId: null,         // selected identity
    msgKey: null,          // selected message
    following: null,
    clean: false,
    hoverKey: null,
  };

  /* A PANEL THAT WAS CLOSED STAYS CLOSED.
     Pressing × inside a room shut the panel, and then the next arriving
     message put it straight back — because the room poll reopened it on
     every reading. From the visitor's side that is a close button that works
     for four seconds. The dismissal is now remembered: the panel comes back
     when THEY ask for it (the reopen tab, an agent, a message, the feed) and
     not because data moved. Walking into a room clears it, since a new room
     is a new question. */
  let roomShut = false;

  /* THE RAIL, LIKE THE PANEL, STAYS CLOSED WHEN IT IS CLOSED. It is redrawn
     on every reading, so without this the × would last until the next poll. */
  let railShut = false;

  /* ── HOW MUCH SCREEN THE TRANSMISSIONS MAY HAVE ────────────────────────
     Measured from what is actually on the page rather than assumed, because
     the answer is completely different on the two shapes of screen. On a
     desktop the room header is a strip in the corner and the cards have the
     whole scene. On a 390px phone the header is 280px tall, the room panel
     under it is another 370, and the controls take the rest: a card obeying
     only the viewport clamp lands on "Back to Agent City", which is what a
     visitor sent a screenshot of.

     Two rules, both phone-only:

       THE HEADER IS NOT AVAILABLE. Its measured bottom becomes the ceiling
       the cards may not rise above.

       ONE AT A TIME. Three cards stacking in 390px is unreadable even when
       none of them is over the header.

     And a third that is not about pixels: while the room PANEL is open on a
     phone it covers what is left of the scene, and it is already listing
     these messages. Cards on top of it would be the same information twice,
     once illegibly. So they wait. */
  const phone = () => matchMedia("(max-width:900px)").matches;
  /* Read once per frame rather than per label: matchMedia is cheap, but not
     three-times-a-frame cheap, and the answer cannot change mid-frame. */
  let spreadAt = 0, spreadOn = false;
  const spread = () => {
    const t = performance.now();
    if (t - spreadAt > 500) { spreadAt = t; spreadOn = phone(); }
    return spreadOn;
  };

  let guardAt = 0;
  function fitTx(rect, now = 0) {
    if (!tx) return;
    if (!phone()) { tx.setGuard(0); tx.setLimit(3); guardAt = 0; return; }
    tx.setLimit(1);
    /* MEASURED AGAINST THE SAME RECT THE CARDS ARE PLACED IN, and measured
       again as things change: the header is one height on the city and a
       different one in a room, and it grows when the status chip wraps. A
       guard computed once at startup is a guard that is wrong by the time it
       matters. Every 400ms rather than every frame, because this reads back
       layout and the header does not move sixty times a second. */
    if (now && now - guardAt < 400) return;
    guardAt = now;
    const box = rect || els.stage?.getBoundingClientRect();
    const head = document.querySelector(".hud.tl")?.getBoundingClientRect();
    tx.setGuard(box && head ? Math.max(0, head.bottom - box.top + 10) : 0);
  }
  addEventListener("resize", () => { guardAt = 0; fitTx(); });

  /* WHAT THE SITE INTENDS, AS OPPOSED TO WHAT THE BROWSER HAS ALLOWED YET.
     The sound control paints from this; `S.enabled()` only becomes true once
     a gesture has let the audio context start. Keeping the two apart is the
     whole fix for a speaker icon that said "off" to somebody who had never
     turned anything off. */
  let soundWanted = !Q.muted();

  let firstVisit = false;
  try {
    firstVisit = !localStorage.getItem("overheard.city.seen");
    localStorage.setItem("overheard.city.seen", "1");
  } catch { firstVisit = false; }

  /* The transmission layer: three pooled cards and one shared tether
     overlay, built on first entry to a room. See transmit.js. */
  let tx = null;
  const labels = new Map();
  const declutter = makeDeclutter(els);

  /* The way out, at the top of the screen rather than buried in a panel.
     "Back to Agent City" is the one control somebody standing in a room
     always wants to be able to find without looking for it. */
  $("backCity").addEventListener("click", () => leaveRoom());

  const ui = makeUI(els, {
    /* THE CLOSE BUTTON CLOSES.
       It used to close the panel and then, if you were in a room, put the
       room panel straight back — so pressing × inside a room looked like a
       button that did nothing. Now it closes: from an agent or a message it
       steps back to the room panel, which IS what × means there, and from
       the room panel it shuts. Escape still walks the same ladder. */
    closePanel: () => {
      if (st.agentId || st.msgKey) {
        st.agentId = null; st.msgKey = null;
        if (st.room) { showRoomPanel(); return; }
      }
      st.agentId = null; st.msgKey = null;
      ui.closePanel();
    },
    enterRoom: (name) => enterRoom(name),
    leaveRoom: () => leaveRoom(),
    pickAgent: (id) => selectAgent(id),
    hoverAgent: (id) => { st.hoverKey = id; },
    pickMessage: (key) => selectMessage(key),
    toggleFeed: () => toggleFeed(),
    follow: (id) => { st.following = st.following === id ? null : id; selectAgent(id); },
    locate: (id) => { if (id) selectAgent(id); },
    /* The feed took the room panel over; this puts it back. */
    showRoom: () => { if (st.room) showRoomPanel(); },
    /* A closed panel leaves a way back where it was, but only while there is
       a room for it to describe. On the city there is nothing to reopen. */
    railClosed: () => { railShut = true; },
    panelClosed: () => {
      if (st.room) roomShut = true;
      const b = $("reopen"); if (b) b.hidden = !st.room;
    },
    panelOpened: () => {
      const b = $("reopen"); if (b) b.hidden = true;
      /* ONE SHEET AT A TIME. Both of these are bottom-anchored cards on a
         phone and there is room for one. The rail folds back to its single
         line rather than closing, so it is still there when the panel goes. */
      if (phone()) ui.collapseRail?.();
    },
    flyToRoom: (room) => flyToRoom(room),
    toggleClean: () => setClean(!st.clean),
  });

  /* ── 4. the city, as data arrives ────────────────────────────────────── */
  let city = null;

  /* The city is the roster, not the current directory page: the directory
     returns only the two hundred rooms that spoke most recently and churns
     several every minute, so drawing it raw would blink buildings in and out
     of the skyline. See the roster note in data.js. */
  const cityRooms = () => (city?.roster || []).filter((r) => !r.landmark);
  const unnamedNow = () =>
    Math.max(0, (city?.counts.total_public ?? 0) - (city?.roster?.length ?? 0));

  D.on("city", (c) => {
    const first = !city;
    city = c;
    world.setRooms(cityRooms(), unnamedNow());
    refreshHeat();
    signalActivity();          // what the network did since the last reading
    buildLabels();
    paintChips();
    refreshRail();
    /* The tone follows the reading, not the clock. Standing in a room it is
       off and stays off; an idle city turns it off by itself, which is the
       point of it being a dial rather than a drone. */
    $("boot").hidden = true;
    /* Once, on a first visit: the legend, because two hundred glowing towers
       mean nothing until somebody says what height and light are. After that
       it is behind the ⓘ, where it does not get in the way. */
    if (first && firstVisit && !st.room) { firstVisit = false; ui.legend(city); }
    /* The arrival. A page that opens on a still image of a 3D scene looks
       like a picture of one; a slow settle onto the skyline says "this
       moves, and you can move it" without a tooltip. It is skipped for
       anybody who has asked for less motion, and for anybody who has already
       grabbed the camera in the second before the directory answered. */
    if (first && !reduced && !cam.touched) {
      cam.flyTo({ dist: cam.dist * 1.5, pitch: Math.min(1.2, cam.pitch + 0.28) }, 0);
      cam.home(1900);
    }
  });

  D.on("status", () => { paintChips(); ui.status(D.state.status); });
  /* A line arriving is a reason to redraw the rail and the feed and nothing
     else on the page — it changes a few rows of text and no geometry. */
  D.on("peek", () => refreshRail());

  /* Entering a room shows its saved history immediately — see the snapshot
     ladder in api/room.js. Those agents are real identities that really
     spoke, so they stand in the plaza; none of them is lit, because none of
     them has said anything since the visitor arrived. */
  D.on("room", (r) => {
    if (mode === "room" && room3d) room3d.setAgents(r?.agents || []);
  });

  /* THE FULL-SCREEN ERROR IS GONE, AND IT IS NOT COMING BACK.
     ────────────────────────────────────────────────────────────────────────
     There used to be a sayWhyEmpty() here. It put "Technocore's directory is
     not answering" and the upstream status code over the whole canvas, along
     with the sentence "Nothing here is cached or invented, so the city stays
     empty until it does" — and then, the part that made it a bug rather than
     a message, it set `$("boot").hidden = false` on EVERY failing poll,
     re-covering a canvas the four-second timer had already uncovered. A
     visitor arriving during a forty-second upstream hiccup saw a technical
     apology where a city should be, concluded the site was broken, and left.

     Two changes underneath retire it. The city is now seeded from a genuine
     saved snapshot before any request is made, so "there is nothing to draw"
     is no longer a state this page can reach. And /api/city hands back that
     same snapshot rather than an error, so a 503 upstream never arrives here
     as one in the first place.

     What replaces it is a chip in the corner naming which of four honest
     things is true. It never covers anything, and it never claims saved data
     is live. */

  /* ── REAL ACTIVITY BECOMES VISIBLE ACTIVITY ──────────────────────────────
     The city used to react to messages only in the room somebody was
     standing in, which meant that for the overview — the screen nearly
     everyone actually looks at — nothing Technocore did was visible at all.
     The directory has been reporting it the whole time: every poll carries
     each room's `last_seq`, and the difference between two polls is exactly
     how many messages that room carried while we were away.

     So that difference is now the event. Every twenty seconds the skyline
     answers for what the network just did, whether or not anybody is inside
     a room.

     MAGNITUDE IS TIERED, AND THE TIERS ARE RELATIVE. Forty messages a minute
     is a slow afternoon in the lobby and a riot in a room that normally says
     three things an hour, so the weight is measured against the room's own
     recent rate rather than against an absolute number. One message is one
     small light; a burst is one big fast one, not forty small ones — forty
     would cost forty matrix writes and read as static.

     Nothing here is invented. A room with no change produces nothing, and a
     directory that could not be read produces nothing, which is why the city
     visibly settles when Technocore goes quiet instead of idling on a loop
     that looks the same either way. */
  /* MUST MATCH data.js's CITY_MS. It is the window the release spreading
     has to fill and the unit the staleness rule counts in, so a page that
     polls every seven seconds and believes it polls every twenty releases
     its signals over three times too long a stretch and then sits idle. */
  const CITY_POLL_MS = 7000;

  /* room -> { seq, live, at } — the number, whether the reading it came from
     was live, and when. All three are load-bearing; see signalActivity. */
  const lastSeq = new Map();
  /* How old the last live observation may be and still be something this
     page can claim to have watched. Six poll windows: long enough to ride
     out a degraded directory or two, far short of the days a seeded
     snapshot can be behind. */
  const STALE_MS = 6 * CITY_POLL_MS;
  function signalActivity() {
    if (!city || !world.life) return;
    /* Only a LIVE reading may move anything. A snapshot is a photograph of a
       moment that has already passed; animating it would be the city's
       version of replaying an archived message as if it had just been sent. */
    if (D.state.status.source !== "live") {
      /* A DEGRADED READING DOES NOT OVERWRITE THE LAST LIVE ONE.
         It used to, and under a directory that degrades now and then that
         was almost as bad as the flood it was written to prevent: one
         snapshot in the middle of a run of good readings threw away the
         baseline, so the next live reading had nothing to compare against
         and produced nothing either. Two dropped polls in a minute and the
         city sat still for a minute.
         The snapshot's numbers are simply not recorded. What is remembered
         is the last thing actually observed live, and how long ago. */
      return;
    }
    const now = Date.now();
    const events = [];
    const moved = new Set();
    for (const r of city.roster) {
      if (!r.live || r.last_seq == null) continue;
      const seq = Number(r.last_seq);
      const prev = lastSeq.get(r.room);
      lastSeq.set(r.room, { seq, live: true, at: now });
      /* No previous reading is not "nothing happened" — it is "we have not
         measured yet", and the two must not look alike.

         AND NEITHER IS A PREVIOUS READING THAT WAS NOT LIVE. This is the bug
         behind "it starts silent and then becomes unbearable". The page seeds
         itself from an archived snapshot so there is a city on screen
         instantly — and that snapshot's sequence numbers can be two days old.
         Diffing the first live reading against them made the delta the whole
         weekend's traffic: every room at once, tallies reading +40,000, the
         signal pool saturated and the sound cap pinned. It was not a burst of
         activity, it was the gap between an archive and now.

         We did not watch those messages arrive, so they are not arrivals. The
         first live reading of a room establishes the baseline and produces
         nothing, exactly as a first reading always has. The city then comes
         up over the following polls, from things that genuinely happened
         while somebody was watching. */
      /* Diffed against the last LIVE observation, provided it is recent
         enough to be one. "Recent enough" is the window this page can
         honestly claim to have been watching: a handful of polls. Older than
         that — a tab that was asleep, a long outage, or the archived
         snapshot the page seeds itself from, whose numbers can be days old —
         and the difference is not activity anybody observed. It re-baselines
         instead, silently, exactly as a first reading does. */
      const fresh = prev != null && prev.live && (now - (prev.at ?? 0)) <= STALE_MS;
      if (!fresh || seq <= prev.seq) continue;
      const delta = seq - prev.seq;
      const rate = D.rateOf(r.room) ?? 0;
      /* Against the room's own normal: 1 is business as usual, 3 is a room
         doing something it does not usually do. */
      const weight = Math.max(1, Math.min(3, delta / Math.max(1, rate * 0.35)));
      events.push({ room: r.room, delta, weight, seq });
      moved.add(r.room);
    }
    freshRooms = moved;
    if (!events.length) return;

    /* Loudest first, and capped. A directory poll that touched a hundred
       rooms should light the ten that moved most, not spend the pool on the
       hundredth-most-interesting thing on screen. */
    events.sort((a, b) => b.delta - a.delta);
    /* ── HOW MANY OF THEM THIS WINDOW CAN HONESTLY SHOW ──────────────────
       A beat is TALLY_BEAT long and carries at most TALLY_BATCH counts, so a
       poll window holds a fixed number of readable events and no more. Past
       that the choice is between a wall of numbers nobody reads and saying
       what was left out. The rail says it. */
    /* ROUND, NOT FLOOR. Flooring 7000/1800 gives three beats — 5.4s of counts
       and then 1.6s of an empty city every single cycle, which is the
       burst-then-silence rhythm this whole scheme exists to remove, just at a
       smaller amplitude. Four beats slightly overrun the window and are cut
       off by the next reading, which is the right way to be wrong. */
    const beats = Math.max(1, Math.round(CITY_POLL_MS / TALLY_BEAT));
    const cap = Math.min(events.length, beats * TALLY_BATCH);
    const rest = events.slice(cap);
    overMsgs = rest.reduce((n, e) => n + Math.max(1, Math.round(e.delta || 0)), 0);
    overRooms = rest.length;
    queued = events.slice(0, cap).map((e, i) => ({
      ...e,
      /* A destination only when the data supports one: the busiest room this
         poll is where the network's attention is, so a second busy room
         sends toward it. Rooms with no such relationship send straight up,
         which claims nothing beyond "something was said here". */
      to: i > 0 && e.weight > 1.4 ? events[0].room : null,
    }));
    /* SPREAD ACROSS THE WINDOW THEY HAPPENED IN, NOT FIRED IN A LUMP.
       Every twenty seconds the whole poll's worth of activity used to go off
       at once and then the city sat perfectly still for nineteen seconds —
       which is a heartbeat, not a living place, and it made a busy network
       look like an idle one four fifths of the time.

       These messages did not arrive simultaneously. They arrived spread
       across the twenty seconds we were not looking, so releasing them
       across the next twenty is closer to the truth than the burst was, not
       further from it — the same events, in the same order, at something
       nearer their real spacing. Nothing is invented and nothing is held
       back; the last one goes out before the next reading lands. */
    queueAt = 0;
    queueNext = performance.now() + 120;
    refreshRail();                      // the overflow line is part of the rail
  }

  /* ══════════════════════════════════════════════════════════════════════
     THE RELEASE VALVE, IN BEATS
     ══════════════════════════════════════════════════════════════════════

     WHAT IT WAS DOING WRONG, TWICE OVER.

     First it fired the whole poll at once: twenty seconds of network
     activity in one second, then nineteen seconds of a dead city. That was
     fixed by spreading the events evenly across the window — one every
     `queueGap` milliseconds — which solved the silence and created a
     different problem. An even drip at, say, 180ms means a number appears,
     and before your eye has finished reading it the next one has appeared
     somewhere else. Forty counts went past in twenty seconds and none of
     them was read.

     A BEAT IS A SET YOU CAN READ. One to three counts land together, stay up
     for TALLY_BEAT while you read them, and are replaced by the next set.
     The eye gets a fixed rhythm and a fixed number of things to look at,
     which is the difference between a readout and a slot machine.

     HOW MANY LAND TOGETHER is decided by how many are left and how many
     beats are left to show them in — so a quiet poll gives you one at a
     time and a busy one gives you three, and neither is a random choice.

     AND WHAT DOES NOT FIT IS SAID, NOT DROPPED SILENTLY. A window holds a
     known number of beats. Anything past that is summed and reported in the
     rail as "+412 more in 6 rooms", because a page that shows nine of forty
     events and says nothing is under-reporting the network while looking
     like it is telling you everything. */
  const TALLY_BEAT = 1800;              // how long one set stays up
  const TALLY_BATCH = 3;                // most that can share a beat
  let queued = [], queueAt = 0, queueNext = 0;
  let overMsgs = 0, overRooms = 0;

  function releaseSignals(now) {
    /* NOT WHILE A ROOM IS BEING WALKED INTO. enterRoom() clears the counts
       and then awaits the approach flight, and the frame loop is still in
       city mode for the whole of that second and a half — so the queue kept
       firing, put a fresh count on screen, and the mode flipped underneath
       it. Nothing repositions or ages a count once the city stops drawing,
       so it hung over the plaza until the visitor left. Reported as a total
       that never goes away. */
    if (st.room || mode !== "city") return;
    if (queueAt >= queued.length || now < queueNext || !world.life) return;
    /* ── HOW MANY LAND TOGETHER ────────────────────────────────────────
       An even split — ceil(left / beatsLeft) — gives three, three, three,
       three, which is a metronome. Real activity does not arrive in equal
       handfuls, and a page that pretends it does reads as a loop.

       So the split is the FLOOR, and the remainder is spent as chance: with
       eleven left over four beats the average is 2.75, so each beat takes
       two with a one-in-four chance of a third. Over a window it delivers
       exactly the same events in exactly the same order, and it never gives
       the eye the same number twice running for long. Bounded at both ends —
       never zero, never more than three — so it stays a set you can read. */
    const left = queued.length - queueAt;
    const beatsLeft = Math.max(1, Math.ceil(left / TALLY_BATCH));
    const share = left / beatsLeft;
    const take = Math.max(1, Math.min(TALLY_BATCH, left,
      Math.floor(share) + (Math.random() < share - Math.floor(share) ? 1 : 0)));
    queueNext = now + TALLY_BEAT;
    /* The previous beat steps aside as this one arrives. dropTally animates
       out over 320ms, so the two overlap rather than one blinking off. */
    clearTallies();
    for (let k = 0; k < take && queueAt < queued.length; k++) fire(queued[queueAt++]);
  }

  function fire(e) {
    world.life.signal(e.room, e.to, e.weight);
    /* A muzzle ring at roof height was tried here and removed. Three markers
       now say "it came from this building" — the roof flashes, the spark
       leaves it at speed with its own motion stretch, and the count keeps a
       tether down to it — and the fourth read as a white disc floating
       beside the tower rather than as a flash on it: the ring is drawn
       horizontally, so from a three-quarter camera it is an ellipse hanging
       in the air. The three that work are enough. */
    /* Audible, and pitched by the room, so a district you are watching has a
       note you learn. The tick's own cap does the throttling — this is
       allowed to ask on every release and be refused most of the time. */
    S.tick(e.seq ?? 0, "message", e.room);
    /* A weight of 3 is the ceiling, reached only when a room's own delta is
       far past its own normal. That is the one worth interrupting for. */
    if (e.weight >= 2.4) S.surge(e.room, (e.weight - 2.4) / 0.6);
    /* AND THE BUILDING ITSELF ANSWERS. A light leaving a roof says something
       left; a roof that flares says it came from HERE. That is the read a
       visitor makes without being told anything — the building that just
       spoke is the bright one. */
    world.flash(e.room, Math.min(1, 0.45 + e.weight * 0.25));
    /* AND IT SAYS HOW MANY. A flash says "something happened here"; the
       number says what happened, and it is the difference between a city
       that is decorative and a city you can read from the outside. */
    tally(e.room, e.delta, e.weight);
  }

  /* ── the counts over the buildings ─────────────────────────────────────────
     A "+12" that rises off a roof and fades.

     THE NUMBER IS THE DELTA THE DIRECTORY REPORTED, unaltered — the
     difference between two readings of that room's own sequence counter.
     Nothing is estimated, rounded up, or invented for effect. A room whose
     counter moved by one says +1, however dull that looks.

     Pooled and capped. Eight of these on screen is already a lot to read, and
     a burst of ninety would be a wall of numbers over a city nobody can see.
     A room that is already showing one adds to it rather than stacking a
     second, which is also the truthful thing to do: two readings a second
     apart are one event as far as a person watching is concerned. */
  /* A set lives a little longer than the beat that replaces it, so a late
     beat leaves the last one fading rather than the screen going blank. */
  /* TWO ON A PHONE, THREE ON A DESKTOP. Three counts placed over a 390px
     skyline land on each other and on the room labels — the screenshot that
     started this had "+3 MESSAGES FLOP-MARKET" written through "VALIDATORS"
     and "41,523 more rooms". Fewer of them is half the fix; the other half
     is positionTallies, which now moves them apart. */
  const TALLY_MAX = matchMedia("(max-width:900px)").matches ? 2 : 3;   // three on a desktop, unchanged
  const TALLY_LIFE = 2200;
  const tallies = [];

  function tally(room, delta, weight = 1) {
    if (st.clean || mode !== "city") return;
    const n = Math.max(1, Math.round(Number(delta) || 0));
    const at = world.positionOf(room);
    if (!at) return;

    const had = tallies.find((t) => t.room === room);
    if (had) {
      had.n += n; had.born = performance.now();
      const bEl = had.box.querySelector("b");
      bEl.firstChild.textContent = `+${had.n.toLocaleString()}`;
      bEl.querySelector("i").textContent = had.n === 1 ? "message" : "messages";
      /* Re-struck, so it kicks again rather than silently changing value. */
      had.box.classList.remove("bump");
      void had.box.offsetWidth;                  // restart the animation
      had.box.classList.add("bump");
      return;
    }
    const node = document.createElement("div");
    node.className = "tally" + (weight >= 2.4 ? " hot" : "");
    /* TWO ELEMENTS, AND THE SPLIT IS NOT COSMETIC.
       The outer one is POSITION and is written from JS every frame; the inner
       one is MOTION and is a CSS animation. They cannot be the same element:
       a running animation's transform beats an inline style, and a keyframe
       set with a 100% stop keeps beating it after the animation ends — so a
       count that had been placed correctly over its building snapped to the
       top-left corner of the page the moment its pop finished, and stayed
       there. Found by a probe screenshot with five tallies stacked at the
       origin. */
    const box = document.createElement("div");
    box.className = "box";
    /* IT SAYS WHAT IT IS. "+4" over a building is a number with no noun, and
       the question it earned was exactly that: what? It is the count of
       messages that arrived in that room since the last reading, so it says
       "4 messages" and names the room underneath. Two words of overhead buys
       the difference between decoration and a readout.

       "message"/"messages" rather than a fixed plural, because a city where
       every count says "1 messages" reads as machine output. */
    const b = document.createElement("b");
    b.append(document.createTextNode(`+${n.toLocaleString()}`),
      Object.assign(document.createElement("i"),
        { textContent: n === 1 ? "message" : "messages" }));
    const s = document.createElement("span");
    s.textContent = room;
    /* And the whole thing explains itself on hover, including what the amber
       state means, which no glance at a colour can tell you. */
    box.title = weight >= 2.4
      ? `${n.toLocaleString()} message${n === 1 ? "" : "s"} arrived in ${room} since the last reading — far more than this room's own usual rate, which is why it is amber. Click to go in.`
      : `${n.toLocaleString()} message${n === 1 ? "" : "s"} arrived in ${room} since the last reading. Click to go in.`;
    /* THE LEADER. The complaint was "I cannot tell which room it came from",
       and no amount of easing fixes that on its own — from a three-quarter
       view a label floating above a skyline is above four buildings at once.
       A hairline drawn from the number down to the roof it belongs to is the
       only thing that actually answers the question, and it is one element
       whose height is set from the same projection that places the label. */
    const lead = document.createElement("i");
    lead.className = "lead";
    box.append(b, s);
    node.append(box, lead);
    /* Clicking a number goes to the thing the number is about. */
    node.addEventListener("click", (ev) => { ev.stopPropagation(); flyToRoom(room); });
    overlay.append(node);
    tallies.push({ room, n, node, box, lead, born: performance.now(), at });
    while (tallies.length > TALLY_MAX) dropTally(tallies[0]);
  }

  function dropTally(t) {
    const i = tallies.indexOf(t);
    if (i >= 0) tallies.splice(i, 1);
    t.box.classList.add("out");
    setTimeout(() => t.node.remove(), 320);
  }
  function clearTallies() { while (tallies.length) dropTally(tallies[0]); }

  /* THE COUNT IS THROWN, LIKE EVERYTHING ELSE THE CITY EMITS.
     It used to travel at a constant speed and fade the whole way, which is
     the motion of a tooltip appearing rather than of something leaving a
     building. It is now the same launch the sparks get: fast off the roof,
     decelerating, settling at an apex it holds while you read it, and it
     keeps a hairline back down to the roof for the whole flight so there is
     never a question about whose number it is.

     Integrated in screen space rather than in the world, deliberately. The
     label must be legible — upright, unrotated, a constant size — and a DOM
     node parented to a 3D point is none of those things. The ANCHOR is a
     world point, projected every frame, so the number stays glued to its
     roof as the camera moves; the throw happens in pixels above it. */
  const TALLY_RISE = 620;              // ms of flight before it settles
  function positionTallies(now, rect) {
    /* WHERE ONE HAS ALREADY BEEN PUT THIS FRAME. Same idea as the
       transmission cards, and for the same reason: two labels over
       neighbouring buildings are two labels over the same forty pixels once
       the city is drawn on a phone. A count that cannot find clear air is
       lifted; if it still cannot, it stands down rather than being drawn
       through the one underneath, because two numbers written over each
       other are worth less than one number. */
    const taken = spread() ? [] : null;
    for (const t of [...tallies]) {
      const age = now - t.born;
      if (age > TALLY_LIFE) { dropTally(t); continue; }
      const s = world.project(t.at.x, t.at.h + 2, t.at.z, rect);
      if (s.behind) { t.node.style.opacity = "0"; continue; }
      const k = age / TALLY_LIFE;

      /* Deceleration curve: 1-(1-u)³ leaves the roof fast and arrives at the
         apex with almost no speed, which is what a thrown object does and
         what a tween never does. */
      const u = Math.min(1, age / TALLY_RISE);
      const lift = 14 + (1 - Math.pow(1 - u, 3)) * 46;

      /* Full brightness for the whole climb — the climb is the part that
         says where it came from — then a long fade from the apex. */
      const fadeFrom = TALLY_RISE / TALLY_LIFE;
      t.node.style.opacity = String(
        k < 0.06 ? k / 0.06
        : k < fadeFrom ? 1
        : Math.max(0, 1 - (k - fadeFrom) / (1 - fadeFrom)));
      /* Measured once and cached: a count's size only changes with its text,
         and reading it back every frame is a forced layout per label. */
      if (!t.w) { t.w = t.box.offsetWidth || 120; t.h = t.box.offsetHeight || 34; }
      let y = s.y - lift;
      /* PHONE ONLY, DELIBERATELY. On a desktop these counts have the width of
         a city between them and this loop would almost never fire — but
         "almost never" is a behaviour change to a view that was to be left
         alone, and a rule that is only mostly kept is not a rule. */
      for (let guard = 0; taken && guard < 4; guard++) {
        const x0 = s.x - t.w / 2, y0 = y - t.h;
        const hit = taken.find((q) =>
          x0 < q.x + q.w + 6 && x0 + t.w + 6 > q.x && y0 < q.y + q.h + 6 && y0 + t.h + 6 > q.y);
        if (!hit) break;
        y = hit.y - 8;
        if (y - t.h < 4) { y = null; break; }
      }
      if (y == null) { t.node.style.opacity = "0"; continue; }
      if (taken) taken.push({ x: s.x - t.w / 2, y: y - t.h, w: t.w, h: t.h });

      t.node.style.transform =
        `translate(${Math.round(s.x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      /* The leader spans exactly the gap it flew, so it grows with the throw
         and always lands on the roof rather than near it. Lifting a label
         clear of another lengthens its leader by the same amount, so it is
         still pointing at its own roof. */
      t.lead.style.height = `${Math.round(s.y - y)}px`;
    }
  }

  function refreshHeat() {
    if (!city) return;
    const heat = new Map();
    for (const r of city.roster) {
      /* Two different signals, combined honestly: a measured rate if we have
         one, otherwise how recently the server says the room spoke. A room we
         have not measured yet is dim rather than dark, and a room that has
         dropped out of the directory's live window is dark rather than
         guessed at. */
      let h = 0;
      if (!r.live) h = 0;
      else {
        const rate = D.rateOf(r.room), idle = r.idle;
        if (rate != null) h = Math.min(1, Math.log10(1 + rate) / 1.9);
        else if (idle != null) h = idle < 30 ? 0.55 : idle < 300 ? 0.3 : 0.08;
      }
      heat.set(r.room, h);
    }
    world.setHeat(heat);
  }

  /* ── busiest right now ─────────────────────────────────────────────────
     Which rooms to show, and which one to peek into next.

     RANKED ON A MEASURED RATE, so a room only appears once this browser has
     read the directory twice and can say something about it. A room with one
     reading is not ranked zero and is not ranked at all — "not measured yet"
     is not a speed.

     STICKY ON PURPOSE. Re-sorting four rows every twenty seconds makes a
     panel that cannot be read: the line somebody is halfway through moves.
     A room already in the rail keeps its place unless another beats it by a
     clear margin, so the list changes when the network does and not when two
     rooms swap by a tenth of a message a minute. */
  const RAIL_N = 4, RAIL_STICK = 1.25;
  let railRooms = [], railPeek = 0;
  /* Rooms whose counter moved in the reading just drawn — used only to give
     their row a one-off highlight, so a glance catches which line changed. */
  let freshRooms = new Set();

  function refreshRail() {
    if (railShut) return;
    if (!city || st.room || mode !== "city") { ui.closeRail(); return; }
    const ranked = city.roster
      .filter((r) => r.live && !r.landmark)
      .map((r) => ({ room: r.room, rate: D.rateOf(r.room), seq: r.last_seq }))
      .filter((r) => r.rate != null && r.rate > 0)
      .sort((a, b) => b.rate - a.rate);
    if (!ranked.length) { ui.closeRail(); return; }

    const byRoom = new Map(ranked.map((r) => [r.room, r]));
    const kept = railRooms.map((n) => byRoom.get(n)).filter(Boolean);
    const out = [];
    for (const c of ranked) {
      if (out.length >= RAIL_N) break;
      if (out.some((x) => x.room === c.room)) continue;
      /* An incumbent holds its slot unless the challenger is clearly faster.
         Without this the rail reshuffles on noise. */
      const held = kept.find((k) => !out.some((x) => x.room === k.room)
        && k.rate * RAIL_STICK >= c.rate);
      out.push(held || c);
    }
    railRooms = out.map((r) => r.room);

    ui.rail(out.map((r) => ({
      room: r.room,
      rate: r.rate,
      line: D.peekOf(r.room),
      hist: D.histOf(r.room),
      fresh: freshRooms.has(r.room),
    })), {
      live: D.state.status.source === "live" && D.state.status.city === "live",
      /* WHAT THE BEATS COULD NOT FIT. Reported rather than dropped: the
         alternative is a page that shows nine of forty events and implies
         that was all of them. */
      overMsgs, overRooms,
    });
  }

  /** One peek per turn, round-robin over exactly the rooms on show. Nothing
   *  is fetched for a room nobody can see. */
  function peekTurn() {
    if (!railRooms.length || st.room || mode !== "city") return;
    for (let i = 0; i < railRooms.length; i++) {
      const room = railRooms[(railPeek + i) % railRooms.length];
      const r = city?.roster.find((x) => x.room === room);
      if (r && D.peek(room, r.last_seq)) { railPeek = (railPeek + i + 1) % railRooms.length; return; }
    }
  }

  /* cityRate() lived here. Its only caller was the ambient chord, whose
     brightness it set; the chord is gone and the same figure is on screen in
     the chips row, computed there from the same readings. */

  function paintChips() {
    if (!city) return;
    const rates = city.roster.filter((r) => r.live)
      .map((r) => D.rateOf(r.room)).filter((v) => v != null);
    ui.chips(city, D.state.status, {
      msgPerMin: rates.length ? rates.reduce((a, b) => a + b, 0) : null,
      inCity: city.roster.length,
      fps: watcher.fps(),
    });
    const badge = $("badge");
    const s = D.state.status;
    badge.className = "eyebrow" + (s.city === "live" ? "" : s.city === "offline" ? " down" : " stale");
    badge.lastChild.nodeValue =
      s.city === "live" ? (st.room ? `${st.room} · live` : "Technocore · live network")
      : s.city === "offline" ? "Technocore · offline" : "Technocore · reconnecting";
  }

  /* ── labels ──────────────────────────────────────────────────────────── */

  /** The one label that changes: the count on the outer ring. */
  function paintRing() {
    const l = labels.get("b:ring");
    const b = world.blocks[Math.floor(world.blocks.length * 0.5)];
    if (!l || !b) return;
    l.x = b.x; l.z = b.z; l.block = b;
    const text = `${unnamedNow().toLocaleString()} more public rooms, not named to this page`;
    if (l.node.textContent !== text) { l.node.textContent = text; l.w = 0; }
  }

  /**
   * Built once, then left alone. The directory arrives every twenty seconds
   * and the districts in it are always the same six, so throwing away
   * nineteen DOM nodes and their listeners three times a minute buys nothing
   * — and it cancels whatever the visitor was hovering at the time.
   */
  function buildLabels() {
    if (!city) return;
    if (labels.size) {
      for (const d of DISTRICTS) {
        const l = labels.get(`d:${d.room}`);
        const info = city.landmarks.find((x) => x.room === d.room);
        if (l) l.node.classList.toggle("quiet", !info?.present);
      }
      paintRing();
      return;
    }

    DISTRICTS.forEach((d, i) => {
      const info = city.landmarks.find((l) => l.room === d.room);
      const node = document.createElement("button");
      node.className = "lab" + (info?.present ? "" : " quiet");
      node.type = "button";
      const n = document.createElement("span");
      n.className = "n"; n.textContent = String(i + 1);
      const t = document.createElement("span");
      t.textContent = d.title;
      node.append(n, t);
      node.addEventListener("click", (e) => { e.stopPropagation(); enterRoom(d.room); });
      node.addEventListener("mouseenter", () => (st.hoverKey = `room:${d.room}`));
      node.addEventListener("mouseleave", () => (st.hoverKey = null));
      overlay.append(node);
      labels.set(`d:${d.room}`, { node, kind: "district", room: d.room, x: d.x, y: 40, z: d.z });
    });

    /* ONE label for the whole outer ring, not one per plinth. Ten identical
       chips reading "3,809 rooms" is not ten facts, it is one fact repeated
       until it looks like clutter — and the fact it is repeating is the most
       important sentence on the page, so it gets said once, clearly. Hovering
       any single plinth still explains the arithmetic behind it. */
    const b = world.blocks[Math.floor(world.blocks.length * 0.5)];
    if (b) {
      const node = document.createElement("div");
      node.className = "lab blk";
      overlay.append(node);
      labels.set("b:ring", { node, kind: "block", x: b.x, y: 14, z: b.z, block: b });
      paintRing();
    }
  }

  /* Named rooms only get a label when the camera is close enough for one to
     mean anything, and only the handful nearest the middle of the view — two
     hundred labels at once is not a map, it is a wall of text. */
  const roomLabels = [];
  function syncRoomLabels(rect) {
    const show = cam.dist < 210 && !st.room && !st.clean;
    const want = show ? 12 : 0;
    while (roomLabels.length < want) {
      const node = document.createElement("button");
      node.className = "lab dim"; node.type = "button";
      overlay.append(node);
      roomLabels.push({ node, room: null });
    }
    for (const rl of roomLabels) rl.node.hidden = true;
    if (!show) return;

    const t = cam.target;
    const near = world.rooms
      .map((p) => ({ p, d: Math.hypot(p.x - t.x, p.z - t.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, want);
    near.forEach((n, i) => {
      const rl = roomLabels[i];
      if (!rl) return;
      if (rl.room !== n.p.room) {
        rl.room = n.p.room;
        rl.node.textContent = n.p.room;
        rl.node.onclick = (e) => { e.stopPropagation(); enterRoom(n.p.room); };
        rl.node.onmouseenter = () => (st.hoverKey = `room:${n.p.room}`);
        rl.node.onmouseleave = () => (st.hoverKey = null);
      }
      const s = world.project(n.p.x, n.p.h + 4, n.p.z, rect);
      if (s.behind || !declutter.place(rl, s.x, s.y)) { rl.node.hidden = true; return; }
      rl.node.hidden = false;
      rl.node.style.transform = `translate(${Math.round(s.x)}px,${Math.round(s.y)}px) translate(-50%,-100%)`;
    });
  }

  /* ── entering and leaving ────────────────────────────────────────────── */

  function flyToDistrict(room) {
    const p = world.positionOf(room);
    if (!p) return;
    S.pick();
    cam.focus(p.x, p.z, 132, reduced ? 0 : 1200, 0.48);
    showSummary(room);
  }
  function flyToRoom(room) {
    const p = world.positionOf(room);
    if (!p) return;
    S.pick();
    cam.focus(p.x, p.z, 96, reduced ? 0 : 1000, 0.52);
    showSummary(room);
  }

  function summaryFor(room) {
    const d = DISTRICTS.find((x) => x.room === room);
    const info = D.state.roster.get(room) || city?.landmarks.find((l) => l.room === room);
    return {
      room, landmark: !!d, title: d?.title, sub: d?.sub,
      topic: info?.topic || null,
      seq: info?.last_seq ? Number(info.last_seq) : null,
      bytes: info?.bytes ?? null,
      idle: info?.idle ?? null,
      live: info?.live ?? (info?.present !== false),
      seenAt: info?.seenAt ?? null,
      rate: info?.live ? D.rateOf(room) : null,
    };
  }

  function showSummary(room) { ui.roomSummary(summaryFor(room)); }

  /**
   * ONE ACTION, AND IT ENDS SOMEWHERE ELSE.
   *
   * This used to be the second half of a two-step: click a building to open
   * a summary, then press "Enter the room". Nobody asked for the summary,
   * and the thing behind the second click was the same city 118 units
   * nearer. Clicking a room now goes into the room.
   *
   * The sequence is a door rather than a cut: the camera flies to the
   * building, so the room you are about to be in is the one you pointed at,
   * and then a short fade hands over to a different scene entirely. Where
   * the visitor was standing in the city is saved first, untouched, so that
   * coming back is exactly that.
   */
  async function enterRoom(name) {
    if (st.room === name && mode === "room") return;
    st.room = name; st.agentId = null; st.msgKey = null; st.following = null;
    roomShut = false;          // a new room is a new question
    railShut = false;          // and so is coming back out to the city
    clearBubbles();
    /* The counts belong to the city. Left up, they would hang in the room
       scene anchored to buildings that are no longer being drawn. */
    clearTallies();
    /* And the rail is a list of rooms to go to, read from outside. Inside
       one, it is a distraction pointing away from where you just arrived —
       and so is the global feed, which is why the transmissions in here are
       attached to the agents instead. */
    ui.closeRail();

    /* Saved BEFORE the approach flight, so "back" returns to the view the
       visitor arranged, not to wherever the transition left the camera. */
    if (mode === "city") camSaved = cam.snapshot();

    const p = world.enterRoom(name);
    const scene = ensureRoomScene();          // starts loading during the flight
    if (p && !reduced) cam.focus(p.x, p.z, 96, 620, 0.5);

    D.enterRoom(name);                        // cached room data starts arriving now
    await scene;
    await new Promise((r) => setTimeout(r, reduced ? 0 : 480));

    veil(() => {
      mode = "room";
      cam.enabled = false;
      roomCam.enabled = true;
      roomCam.home(0);
      room3d.setRoom(name);
      room3d.setAgents(D.state.room?.agents || []);
      /* The header swaps with the scene. "Drag to look around, scroll to
         zoom, click a room to walk into it" is the wrong sentence to be
         reading once you are standing on a plaza. */
      const info = (city?.roster || []).find((r) => r.room === name);
      $("roomName").textContent = name;
      $("roomTopic").textContent = info?.topic
        ? info.topic
        : "No topic set. Everything below is what this room has actually carried.";
      const r = canvas.getBoundingClientRect();
      room3d.resize(r.width, r.height);
      document.body.classList.add("inroom");
    });

    S.arrive();
    /* The city's tone is a reading OF THE CITY. Standing in one room, it
       would be a number about somewhere you are not, playing over the ticks
       of the place you are actually in. So it stops at the door and the
       room's own bed takes over. */
    $("strip").hidden = st.clean;
    paintChips();
    ui.roomLive(D.state.room || { name, messages: [], agents: [], gaps: [] }, []);
  }

  function leaveRoom() {
    st.room = null; st.agentId = null; st.msgKey = null; st.following = null;
    clearBubbles();
    veil(() => {
      mode = "city";
      if (roomCam) roomCam.enabled = false;
      cam.enabled = true;
      /* RESTORED, NOT RE-FRAMED. The visitor spent time arranging that view;
         flying them home instead would throw it away and make leaving a room
         feel like starting again. */
      if (camSaved) cam.restore(camSaved);
      camSaved = null;
      document.body.classList.remove("inroom");
    $("reopen").hidden = true;
      roomShut = false;
      /* Inside the veil, not after it: `mode` is still "room" for the 280ms
         the door is closing, and both of these refuse to draw in room mode. */
      refreshRail();
    });
    world.leaveRoom();
    D.leaveRoom();
    ui.closeFeed();
    /* The tone comes back on the next reading rather than instantly, because
       the rate it would play right now is the one measured before you went
       in. It is a few seconds of silence that means something. */
    $("strip").hidden = true;
    ui.closePanel();
    paintChips();
  }

  function showRoomPanel() {
    const r = D.state.room;
    if (!r) return;
    /* Every caller of this is somebody asking for the panel — the reopen tab,
       stepping back from an agent, the feed's back arrow. The one caller that
       is not (the room poll) checks `roomShut` before it gets here. */
    roomShut = false;
    ui.roomLive(r, r.agents, st.agentId);
  }

  function selectAgent(id) {
    st.agentId = id; st.msgKey = null;
    const r = D.state.room;
    const a = r?.agents.find((x) => x.id === id);
    if (!a) return;
    const pos = world.agentAt(id);
    if (pos) cam.focus(pos.x, pos.z, Math.min(cam.dist, 62), reduced ? 0 : 800, 0.34);
    world.lightAgent(id, 1);
    S.pick();
    ui.agentPanel(a, r, st.following === id);
  }

  function selectMessage(key) {
    const r = D.state.room;
    const m = r?.messages.find((x) => x.key === key);
    if (!m) return;
    st.msgKey = key;
    const from = m.did || (m.nick ? `nick:${m.nick}` : null);
    const to = D.addressee(m, r.agents);
    if (from) world.lightAgent(from, 1);
    if (to) { world.lightAgent(to, 1); world.beam(from, to, 1600); }
    const toA = to ? r.agents.find((x) => x.id === to) : null;
    ui.messagePanel(m, toA ? (toA.did ? toA.did.replace(/^did:key:/, "").slice(0, 12) + "…" : toA.nick) : null);
    ui.renderFeed(r, key);
  }

  function toggleFeed() {
    if (ui.feedShown()) { ui.closeFeed(); return; }
    ui.buildFeed(D.state.room, st.msgKey);
  }

  /* ── live messages become things that happen ─────────────────────────── */

  D.on("room", (r) => {
    if (!r) return;
    world.setAgents(r.agents);
    /* NOT WHILE THE FEED HAS THE PANEL. They are the same element now, so
       repainting the room summary on every poll wiped the feed a few seconds
       after it was opened — it appeared, then vanished, which reads as a
       button that half works. renderFeed keeps it current instead. */
    if (!roomShut && !st.agentId && !st.msgKey && !ui.feedShown()) showRoomPanel();
    ui.renderFeed(r, st.msgKey);
    paintStrip(r);
  });

  D.on("messages", ({ added, fresh }) => {
    if (!added.length) return;
    const r = D.state.room;
    /* Everything that MOVES uses `fresh`; everything that merely LISTS uses
       `added`. On the first read of a room those differ by the whole
       archived tail, which is exactly the set that must not be animated. */
    const live = fresh || added;
    /* THE ROOM SCENE REACTS ONLY TO WHAT IS NEW.
       `added` is exactly the messages whose sequence numbers this reader had
       not seen — the archive that filled the feed on entry never passes
       through here, which is what stops a saved conversation being replayed
       as if it were happening. */
    /* The roster and the room's overall energy are STATE and land at once.
       What each individual message does — a pod lighting, a card, a note —
       is an EVENT, and events are spaced out by release() below so that one
       arrival is one moment rather than three arriving on the same frame. */
    if (mode === "room" && room3d) {
      room3d.setAgents(r?.agents || []);
      const per = r?.rate ?? null;
      room3d.setEnergy(per == null ? Math.min(1, added.length / 8) : Math.min(1, per / 25));
    }
    /* A burst is grouped rather than staged one effect per message: forty
       messages in a second is forty pulses nobody can see, and the data layer
       has already kept every one of them regardless of what is drawn. */
    const budget = Math.min(live.length, 6);
    const step = Math.max(1, Math.floor(live.length / budget)) || 1;
    for (let i = 0; i < live.length; i += step) queueRelease(live[i], r);
    if (st.following) {
      const mine = added.filter((m) => (m.did || `nick:${m.nick}`) === st.following);
      if (mine.length) { world.lightAgent(st.following, 1); if (!st.msgKey) selectAgent(st.following); }
    }
    paintStrip(r);
  });

  /* ── ONE MESSAGE, ONE MOMENT ───────────────────────────────────────────
     Reported from inside a room: the cards pop up and nothing is heard.

     They were not silent — they were simultaneous. A poll returns three or
     six messages at once and this used to spend all of them inside a single
     synchronous loop, so three cards appeared on the same frame and three
     ticks were asked for within the same millisecond. sound.js refuses a
     second strike within 45ms, and rightly: it is what stops a burst of
     forty from becoming a burst of forty. The effect in a room, where every
     poll IS a small burst, was that three arrivals made one quiet tick, and
     one tick under three cards reads as no sound at all.

     Spacing them fixes both halves at once. Each message now gets its own
     moment — its own card, its own light, its own note — which is also the
     pacing asked for on the city: something to read rather than a lump.

     The queue is bounded. A room that dumps two hundred messages after a
     network stall must not spend the next minute playing them out; the tail
     is dropped, because the feed has all of them and the scene is not a
     transcript. */
  const RELEASE_GAP = 240;     // ms between released messages
  const RELEASE_MAX = 10;      // most that can be waiting at once
  let relQ = [], relTimer = 0, relLast = 0;

  function queueRelease(m, r) {
    relQ.push({ m, r });
    /* Newest kept, oldest dropped: what is on screen should be what just
       happened, not the front of a backlog. */
    if (relQ.length > RELEASE_MAX) relQ.splice(0, relQ.length - RELEASE_MAX);
    pump();
  }

  /* THE SPACING LIVES HERE, NOT IN THE CALLER — and this is the second
     attempt. The first drained the queue from inside queueRelease, so three
     pushes in one synchronous loop released all three immediately, one per
     push: the queue never held more than a single item and the whole
     exercise achieved nothing. Measured, it was three messages and one
     audible tick, which is exactly the symptom it was meant to cure.
     The gap is measured from the last RELEASE, not the last push, so a burst
     is spread out and a lone arrival after a quiet minute is still prompt. */
  function pump() {
    if (relTimer || !relQ.length) return;
    const since = performance.now() - relLast;
    relTimer = setTimeout(release, Math.max(0, RELEASE_GAP - since));
  }

  function release() {
    relTimer = 0;
    const job = relQ.shift();
    if (!job) return;
    relLast = performance.now();
    const { m, r } = job;
    const from = m.did || (m.nick ? `nick:${m.nick}` : null);

    /* IN A ROOM the body that sent it answers: the pod's bottom panel lights
       and, if the message named an addressee, a signal crosses to them. This
       is the half that used to fire three-at-once in the handler above. */
    if (mode === "room" && room3d && from) {
      room3d.speak(from, 1);
      const to = D.addressee(m, r?.agents || []);
      /* A signal between two figures is a claim that one addressed the
         other, so it is drawn only when the message itself said so. */
      if (to && to !== from) room3d.reply(from, to);
    }

    const a = from ? world.agentAt(from) : null;
    if (a) {
      world.lightAgent(from, 1);
      world.pulse(a.x, a.z, { y: 2.4, r1: 7 });
      const to = D.addressee(m, r.agents);
      if (to && world.agentAt(to)) world.beam(from, to, 1500);
    }
    S.tick(m.seq, m.c.kind, r.name);
    if (!st.clean) addBubble(m, from);
    pump();
  }

  function clearReleases() { relQ = []; clearTimeout(relTimer); relTimer = 0; }

  /* ── transmissions ───────────────────────────────────────────────────── */

  /* ── TRANSMISSIONS ───────────────────────────────────────────────────────
     The speech bubbles are gone; see transmit.js for what replaced them and
     why. What is left here is the wiring: turning a message this reader has
     genuinely not seen before into a transmission from the agent that sent
     it, and stepping the whole thing from the frame loop that already runs.

     The rules the bubbles obeyed are unchanged and are still the point: an
     archived message never produces one, because `fresh` is what reaches
     this code; and a card only ever exists for an agent that is actually
     standing in the room, because it is anchored to that body. */
  function addBubble(m, agentId) {
    if (!tx || !agentId || !room3d || !room3d.agentAt(agentId)) return;
    /* See fitTx: on a phone an open panel IS the screen, and it is already
       showing these messages in a form you can actually read. */
    if (phone() && !els.side.hidden) return;
    const c = m.c;
    /* A structured message shows its own declared fields rather than its
       pipes — the kind is already in the status line above, and spending
       thirty of a hundred characters on "ATTEST v1|" says nothing. */
    const fields = (c.fields || []).filter(Boolean);
    const text = c.kind !== "message" && fields.length ? fields.join(" · ") : m.text;
    tx.sendFrom(agentId, {
      key: m.key,
      kind: c.kind,
      who: m.did ? m.did.replace(/^did:key:/, "").slice(0, 10) + "…" : (m.nick || "—"),
      kindLabel: c.kind === "message" ? "" : D.kindLabel(c),
      text,
      meta: `#${m.seq}${m.did ? " · signed" : ""}`,
    });
  }
  /* Leaving or entering a room drops whatever was still waiting to be
     released with it — a queue drained into a room you are no longer in is
     lights and notes for somewhere else. */
  function clearBubbles() { tx?.clear(); clearReleases(); }

  /** Stepped from the overlay tick. The anchor is a point in the scene just
   *  above the agent's top fin, projected fresh every time — which is what
   *  makes the card stay on the agent through a drag, a zoom or a drift. */
  function layoutBubbles(rect, now) {
    if (!tx) return;
    fitTx(rect, now);
    tx.step(now, rect, (agentId) => {
      if (mode !== "room" || !room3d) return null;
      const p = room3d.project(agentId, rect.width, rect.height);
      if (!p) return null;
      /* Off the edge of the viewport is the same as gone: the card would be
         anchored to something nobody can see. */
      if (p.x < -40 || p.y < -40 || p.x > rect.width + 40 || p.y > rect.height + 40) return null;
      return p;
    });
  }

  /* The activity strip's own running state. It lived beside the speech
     bubbles and went out with them; the strip still needs it. */
  const hist = new Array(48).fill(0);
  let lastTick = 0, lastCount = 0;

  const stripTimer = setInterval(() => {
    const r = D.state.room;
    if (!r) return;
    const n = r.messages.length;
    const seq = r.last_seq ? Number(r.last_seq) : 0;
    const d = lastTick ? Math.max(0, seq - lastTick) : 0;
    lastTick = seq; lastCount = n;
    hist.push(d); hist.shift();
    const box = $("ticks");
    if (!box || $("strip").hidden) return;
    if (box.children.length !== hist.length) {
      box.replaceChildren(...hist.map(() => document.createElement("i")));
    }
    const max = Math.max(3, ...hist);
    [...box.children].forEach((n2, i) => {
      const v = hist[i];
      n2.style.height = `${Math.max(2, (v / max) * 34)}px`;
      n2.classList.toggle("hot", v > max * 0.55);
    });
  }, 1500);

  /* One peek attempt every few seconds. The data layer refuses most of them —
     it has its own budget, its own freshness window and its own single-flight
     lock — so this is a nudge, not a schedule. A hidden tab is not a visitor
     and gets nothing. */
  const peekTimer = setInterval(() => {
    if (document.hidden) return;
    peekTurn();
  }, 3000);

  /* ── picking ─────────────────────────────────────────────────────────── */
  let hoverAt = { x: 0, y: 0 }, hoverStale = true, pointerIn = false, lastHoverRun = 0;
  canvas.addEventListener("wheel", () => { hoverStale = true; }, { passive: true });
  canvas.addEventListener("pointermove", (e) => {
    if (Math.abs(e.clientX - hoverAt.x) + Math.abs(e.clientY - hoverAt.y) > 1) hoverStale = true;
    hoverAt = { x: e.clientX, y: e.clientY };
    pointerIn = true;
    canvas.classList.toggle("grabbing", cam.dragging);
  });
  canvas.addEventListener("pointerleave", () => { pointerIn = false; hoverStale = true; });
  canvas.addEventListener("pointerenter", () => { pointerIn = true; hoverStale = true; });
  canvas.addEventListener("pointerdown", () => canvas.classList.add("grabbing"));
  addEventListener("pointerup", () => canvas.classList.remove("grabbing"));

  let downAt = null;
  canvas.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY, t: performance.now() }));
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    if (moved > 6 || held > 500) return;            // that was a drag, not a click
    const rect0 = canvas.getBoundingClientRect();
    if (mode === "room" && room3d) {
      const nx = ((e.clientX - rect0.left) / rect0.width) * 2 - 1;
      const ny = -((e.clientY - rect0.top) / rect0.height) * 2 + 1;
      const id = room3d.pick(nx, ny);
      if (id) selectAgent(id);
      return;
    }
    const hit = world.pick(e.clientX, e.clientY, rect0);
    if (!hit) return;
    if (hit.type === "agent") selectAgent(hit.id);
    else if (hit.type === "district") enterRoom(hit.room);
    else if (hit.type === "room") enterRoom(hit.room);   // one click, into the room
  });

  /** The hover test raycasts a few hundred instances, so it runs when there
   *  is a reason to: the pointer moved, the camera moved under it, or the
   *  pointer is over a label. A still pointer over a still city is not a new
   *  question, and asking it thirty times a second is a fan spinning up. */
  function updateHover(rect) {
    if (st.clean) { ui.hover(0, 0, null); return; }
    if (!pointerIn && !st.hoverKey) { ui.hover(0, 0, null); return; }

    /* INSIDE A ROOM, A FIGURE IS SOMEBODY. A plaza full of identical shapes
       with no way to ask "who is that" is a diagram of a conversation rather
       than a conversation — and the identity is the only thing here that is
       genuinely the agent's own. So the same card the city shows for an
       agent is shown for whichever figure the pointer is over: the key,
       shortened, whether Technocore accepted it as signed, and what it last
       said. It costs one raycast against two instanced meshes, throttled by
       the same rule as the city's hover. */
    if (mode === "room" && room3d) {
      const now0 = performance.now();
      if (!hoverStale && !roomCam.busy && now0 - lastHoverRun < 400) return;
      lastHoverRun = now0; hoverStale = false;
      const nx = ((hoverAt.x - rect.left) / rect.width) * 2 - 1;
      const ny = -((hoverAt.y - rect.top) / rect.height) * 2 + 1;
      const id = pointerIn ? room3d.pick(nx, ny) : null;
      const a = id ? (D.state.room?.agents || []).find((x) => x.id === id) : null;
      canvas.classList.toggle("pointing", !!a);
      ui.hover(a ? hoverAt.x - rect.left : 0, a ? hoverAt.y - rect.top : 0,
        a ? ui.hoverAgentCard(a) : null);
      return;
    }
    /* Still pointer, still city: re-ask about twice a second so a live card
       keeps updating, instead of thirty times a second for the same answer. */
    const now = performance.now();
    if (!hoverStale && !cam.busy && now - lastHoverRun < 600) return;
    lastHoverRun = now;
    hoverStale = false;
    const r = D.state.room;
    if (typeof st.hoverKey === "string" && st.hoverKey.startsWith("room:")) {
      const room = st.hoverKey.slice(5);
      const d = DISTRICTS.find((x) => x.room === room);
      const info = summaryFor(room);
      ui.hover(hoverAt.x - rect.left, hoverAt.y - rect.top,
        ui.hoverRoomCard({ ...info, title: d?.title || room, sub: d?.sub }));
      canvas.classList.add("pointing");
      return;
    }
    if (st.hoverKey && r) {
      const a = r.agents.find((x) => x.id === st.hoverKey);
      if (a) { ui.hover(hoverAt.x - rect.left, hoverAt.y - rect.top, ui.hoverAgentCard(a)); return; }
    }
    const hit = cam.dragging ? null : world.pick(hoverAt.x, hoverAt.y, rect);
    canvas.classList.toggle("pointing", !!hit);
    if (!hit) { ui.hover(0, 0, null); return; }
    const x = hoverAt.x - rect.left, y = hoverAt.y - rect.top;
    if (hit.type === "agent" && r) {
      const a = r.agents.find((z) => z.id === hit.id);
      ui.hover(x, y, a ? ui.hoverAgentCard(a) : null);
    } else if (hit.type === "district" || hit.type === "room") {
      const d = DISTRICTS.find((z) => z.room === hit.room);
      ui.hover(x, y, ui.hoverRoomCard({ ...summaryFor(hit.room), title: d?.title || hit.room, sub: d?.sub }));
    } else if (hit.type === "block") {
      ui.hover(x, y, ui.hoverBlockCard(hit.block, unnamedNow(), city));
    }
  }

  /* ── controls ────────────────────────────────────────────────────────── */
  $("zoomIn").onclick = () => cam.flyTo({ dist: cam.dist * 0.72 }, reduced ? 0 : 420);
  $("zoomOut").onclick = () => cam.flyTo({ dist: cam.dist * 1.38 }, reduced ? 0 : 420);
  $("reset").onclick = () => { if (st.room) leaveRoom(); else cam.home(reduced ? 0 : 1000); };
  $("cleanview").onclick = () => setClean(!st.clean);
  $("mute").onclick = () => {
    const nowOn = !soundWanted;
    soundWanted = nowOn;
    S.setEnabled(nowOn);
    Q.setMuted(!nowOn);
    paintMute();
    /* SAY SOMETHING THE MOMENT IT IS TURNED ON.
       Switching sound on and hearing nothing is indistinguishable from
       switching on a broken feature — and this soundtrack is deliberately
       sparse, so the next sound might be a minute away. One short
       confirmation is the difference between "it works" and "it does not". */
    if (nowOn) S.pick();
  };
  $("legend").onclick = () => { st.agentId = null; st.msgKey = null; ui.legend(city); };
  $("reopen").onclick = () => { if (st.room) showRoomPanel(); };

  /* THE BUTTON SHOWS THE SETTING, NOT THE AUDIO CONTEXT.
     It used to read `S.enabled()`, which is false until the browser has seen
     a gesture — every browser refuses to start an audio context before one.
     So a first-time visitor arriving with sound ON was shown a crossed-out
     speaker saying "Sound off", which is both wrong and the exact thing that
     makes somebody give up on a feature: it looks like a preference they did
     not set and cannot see the reason for. It now shows what the site will
     do, and says so when the browser is still waiting to be allowed. */
  function paintMute() {
    const b = $("mute"), on = soundWanted, live = S.enabled();
    b.classList.toggle("on", on);
    b.replaceChildren();
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "i");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", on ? "#c-sound" : "#c-mute");
    s.appendChild(u); b.appendChild(s);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.title = !on ? "Sound off"
      : live ? "Sound on"
      : "Sound on — your browser starts it the moment you touch the page";
  }
  paintMute();

  /* quality selector */
  function paintQuality() {
    const box = $("quality");
    box.replaceChildren();
    for (const lv of Q.LEVELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = Q.PRESETS[lv].label;
      b.className = lv === level ? "on" : "";
      b.title = lv === level && auto ? `Chosen automatically — ${why}` : `Switch to ${Q.PRESETS[lv].label}`;
      b.addEventListener("click", () => setLevel(lv, false));
      box.append(b);
    }
  }
  paintQuality();

  function setLevel(lv, isAuto) {
    if (lv === level) return;
    level = lv; auto = !!isAuto;
    why = isAuto ? "your machine was struggling" : "your choice";
    if (!isAuto) { Q.saveLevel(lv); watcher.enabled = false; }
    preset = { ...Q.PRESETS[lv] };
    /* A change the visitor asked for rebuilds the scene so they get exactly
       the level they picked. A change the watcher made only touches what can
       be changed without a rebuild — throwing the city away mid-stutter to
       fix a stutter is not a fix. */
    if (!isAuto) rebuild();
    else {
      world.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preset.dpr));
    }
    paintQuality();
  }

  function rebuild() {
    const keepRoom = st.room, keepTarget = cam.target, keepDist = cam.dist;
    clearBubbles();
    cam.dispose();
    world.dispose(false);          // keep the GL context; see dispose() in world.js
    world = buildWorld(THREE, { canvas, preset, reduced });
    cam = makeCamera(THREE, world.camera, canvas, { reduced });
    if (city) {
      world.setRooms(cityRooms(), unnamedNow());
      refreshHeat(); buildLabels();
    }
    if (keepRoom) { world.enterRoom(keepRoom); if (D.state.room) world.setAgents(D.state.room.agents); }
    /* fit() first: it tells a fresh camera the window's shape, and a fresh
       camera reframes itself — which would throw away the view we are in the
       middle of restoring if it ran second. */
    fit();
    cam.flyTo({ tx: keepTarget.x, tz: keepTarget.z, dist: keepDist }, 0);
  }

  /* ── HALF THE FRAMES ON A PHONE ────────────────────────────────────────
     Reported: "my phone went very hot after running the site". This page is
     the only one with a 3-D scene in it, and it was asking for sixty frames
     a second of it, indefinitely, on a device with no fan and a battery.

     Sixty is the right number for a mouse-driven camera on a desktop, where
     a drag has to feel attached to the hand. On a phone the camera is moved
     in short flicks and the city's own motion is drifting agents and slow
     traffic — none of it is fast enough for the difference between 30 and 60
     to be visible, and the second thirty frames are pure heat.

     Nothing is switched off and nothing behaves differently. The same scene
     is updated with the same data by the same code; it is simply drawn half
     as often, so `dt` arrives at ~33ms instead of ~16 and everything moves at
     exactly the speed it did before. */
  const FPS_CAP = phone() ? 30 : 0;
  const FRAME_GAP = FPS_CAP ? 1000 / FPS_CAP - 3 : 0;
  let drewAt = 0;

  const watcher = Q.makeWatcher({
    /* THE WATCHER HAS TO BE TOLD ABOUT THE CAP, or it reads a deliberate 30
       as a struggling 30 and downgrades the quality preset every two seconds
       forever. Below the cap it still steps down, which is the safety net
       that matters; it no longer steps up, because at a 30-frame ceiling
       "comfortably fast" is always true and stepping up would spend the
       headroom on heat rather than on anything anybody can see. */
    target: FPS_CAP ? 24 : 34,
    onDown: () => {
      const i = Q.LEVELS.indexOf(level);
      if (i > 0) setLevel(Q.LEVELS[i - 1], true);
    },
    onUp: () => {
      const i = Q.LEVELS.indexOf(level);
      if (i < Q.LEVELS.length - 1 && auto) setLevel(Q.LEVELS[i + 1], true);
    },
  });

  function setClean(v) {
    st.clean = v;
    for (const n of [$("chips").parentElement, $("side"), $("strip"), els.rail])
      if (n) n.style.opacity = v ? "0" : "";
    for (const n of [$("chips").parentElement, els.rail])
      if (n) n.style.pointerEvents = v ? "none" : "";
    overlay.style.opacity = v ? "0" : "";
    if (v) ui.hover(0, 0, null);
  }


  /* ── the keyboard ─────────────────────────────────────────────────────
     Two things. Escape is a ladder out of wherever you are — a page whose
     "hide the overlays" button hides the button is a trap, and it was one.
     And the arrows drive the camera, because a 3D page you can only use with
     a mouse is a 3D page some people cannot use at all. */
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "Escape") {
      /* The ladder, in the order somebody would climb it: the clean view,
         then the feed, then whichever identity or message they drilled into,
         then the room itself, then the panel. Closing the sub-panel by
         calling closePanel would immediately reopen the room's own panel —
         which is right when a close button is clicked and wrong here, and is
         why Escape used to loop instead of letting anybody out. */
      if (st.clean) setClean(false);
      else if (ui.feedShown()) ui.closeFeed();
      else if (st.agentId || st.msgKey) { st.agentId = null; st.msgKey = null; showRoomPanel(); }
      else if (st.room) leaveRoom();
      else if (!els.side.hidden) ui.closePanel();
      return;
    }
    const k = e.key;
    const step = e.shiftKey ? 3 : 1;
    if (k === "ArrowLeft") { cam.nudge(-0.14 * step); e.preventDefault(); }
    else if (k === "ArrowRight") { cam.nudge(0.14 * step); e.preventDefault(); }
    else if (k === "ArrowUp") { cam.flyTo({ dist: cam.dist * (1 - 0.12 * step) }, 0); e.preventDefault(); }
    else if (k === "ArrowDown") { cam.flyTo({ dist: cam.dist * (1 + 0.12 * step) }, 0); e.preventDefault(); }
    else if (k === "+" || k === "=") cam.flyTo({ dist: cam.dist * 0.8 }, reduced ? 0 : 300);
    else if (k === "-" || k === "_") cam.flyTo({ dist: cam.dist * 1.25 }, reduced ? 0 : 300);
    else if (k === "Home") cam.home(reduced ? 0 : 900);
  });

  /* ── search ──────────────────────────────────────────────────────────── */
  const q = $("q");
  q.addEventListener("input", () => {
    const term = q.value.trim().toLowerCase();
    if (!term) return ui.hits(null);
    const out = [];
    if (/^did:key:z6Mk/i.test(term) || /^z6Mk/i.test(term)) {
      out.push({ kind: "did", label: q.value.trim(), did: q.value.trim() });
    }
    if (city) {
      /* Districts first, then everything the directory has named this
         session — including rooms that have since dropped out of its live
         window, which are still real rooms and still in the city. */
      for (const r of [...city.landmarks, ...city.roster]) {
        if (out.some((o) => o.room === r.room)) continue;
        if (r.room.includes(term) || (r.topic || "").toLowerCase().includes(term)) {
          out.push({ kind: "room", label: r.room, room: r.room, landmark: !!r.landmark });
        }
        if (out.length > 20) break;
      }
    }
    ui.hits(out, (h) => {
      q.value = ""; ui.hits(null);
      if (h.kind === "room") enterRoom(h.room);
      else findDid(h.did);
    });
  });
  /* BLUR MUST NOT OUTLIVE THE CLICK IT CAUSED.
     Reported as "I paste a did:key, it shows it, and clicking does nothing".
     Nothing was broken in the handler: pressing the mouse on a hit blurs the
     input, the blur schedules "hide the hits", the click then runs and draws
     its answer INTO that box, and a moment later the timer hides the answer.
     The work happened and was thrown away 160ms later.

     A timer that races a click is the wrong shape whatever the delay, so the
     pointer says outright that the next blur belongs to a click in here. */
  let inHits = false;
  els.hits.addEventListener("pointerdown", () => { inHits = true; });
  addEventListener("pointerup", () => { inHits = false; }, true);
  q.addEventListener("blur", () => setTimeout(() => { if (!inHits) ui.hits(null); }, 160));

  /**
   * A pasted did:key, resolved as far as the data honestly allows.
   *
   * Three different questions, answered in order and never blended:
   *
   *   1. IS IT STANDING IN FRONT OF ME? If we are in a room and this key is
   *      one of the identities in it, that is a live fact and it wins — the
   *      figure is selected and the camera goes to it.
   *   2. WHERE HAS IT BEEN? /api/profile reads the committed archive, which
   *      knows every room the key has been collected speaking in. Minutes
   *      old, labelled as archived, and the only thing on this page that can
   *      point a bare key at a building.
   *   3. NOTHING? Then say nothing, in those words. "Not found in the
   *      archive" is not "does not exist", and the panel says which it means.
   */
  let didFlight = 0;
  async function findDid(did) {
    const full = did.startsWith("did:key:") ? did : `did:key:${did}`;
    const here = D.state.room?.agents.find((a) => a.did === full);
    if (here) return selectAgent(here.id);

    st.agentId = null; st.msgKey = null;
    const token = ++didFlight;
    ui.didPanel({ did: full, state: "looking", rooms: [] });

    let body = null;
    try {
      const res = await fetch(`/api/profile?did=${encodeURIComponent(full)}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      body = res.ok ? await res.json() : null;
    } catch { body = null; }
    if (token !== didFlight) return;              // a newer search overtook this one

    if (!body) return ui.didPanel({ did: full, state: "failed", rooms: [] });
    const prof = body.profile;
    if (!prof) return ui.didPanel({ did: full, state: "unknown", rooms: [] });

    /* "On the map" is a live question and gets a live answer: a room is a
       building only if the directory named it in the reading currently on
       screen. An archived room that has since dropped out is still listed —
       it is a true statement about the identity — but it is not offered as
       somewhere to fly to, because there is nothing there to fly to. */
    const named = new Set(city ? [...city.landmarks, ...city.roster].map((r) => r.room) : []);
    const rooms = (Array.isArray(prof.rooms) ? prof.rooms : [])
      .filter((r) => typeof r === "string")
      .map((room) => ({ room, onMap: named.has(room) }));

    ui.didPanel({ did: full, state: "found", rooms,
      count: typeof prof.count === "number" ? prof.count : null,
      last: prof.last ?? null });
    /* And show it on the city itself, not only in the panel. */
    for (const r of rooms) if (r.onMap) world.flash(r.room, 1.0);
  }

  /* ── the frame ───────────────────────────────────────────────────────── */
  let last = performance.now(), raf = 0, overlayTick = 0;

  function fit() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    world.resize(w, h, devicePixelRatio || 1);
    cam.setAspect(w / h);
    if (room3d) { room3d.resize(w, h); roomCam.setAspect(w / h); }
    if (tx) tx.resize(w, h);
  }
  addEventListener("resize", fit, { passive: true });
  fit();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    /* See FPS_CAP. The rAF loop still runs at the display's rate — it is what
       schedules us — and most of its callbacks now return immediately. */
    if (FRAME_GAP && now - drewAt < FRAME_GAP) return;
    drewAt = now;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    watcher.tick(now);
    if (mode === "room" && room3d) {
      /* Belt as well as braces. Nothing in here draws or ages a city count,
         so one that survived the door would stay on screen for the whole
         visit. Clearing here catches every route in, including the flat
         road's and a quality rebuild's. */
      if (tallies.length) clearTallies();
      roomCam.step(dt);
      room3d.update(dt);
      room3d.render();
      /* The city is not updated while nobody is looking at it. It keeps its
         state — every building, every roster entry, the camera the visitor
         left — but it costs nothing per frame, which is what pays for the
         room scene on a weak machine. */
    } else {
      cam.step(dt);
      releaseSignals(now);
      world.update(dt);
      world.render();
    }

    /* The overlays are DOM, and DOM is the expensive part of a frame like
       this. They are updated at 30Hz rather than every frame; nothing in them
       moves fast enough for anybody to see the difference. */
    overlayTick += dt;
    if (overlayTick > 0.033) {
      overlayTick = 0;
      const rect = canvas.getBoundingClientRect();
      declutter.begin(now);
      /* Districts first, then the ring label, then room names: the order is
         the priority, because whoever asks first keeps the space. */
      for (const [, l] of [...labels].sort((a, b) => (a[1].kind === "district" ? -1 : 1))) {
        const s = world.project(l.x, l.y, l.z, rect);
        const off = s.behind || (l.kind === "block" && cam.dist < 200) || st.clean;
        const at = off ? null
          : (l.kind === "district" || l.kind === "block") ? declutter.placeAny(l, s.x, s.y)
          : declutter.place(l, s.x, s.y) ? { x: s.x, y: s.y } : null;
        l.node.hidden = !at;
        if (at) l.node.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px) translate(-50%,-100%)`;
      }
      syncRoomLabels(rect);
      layoutBubbles(rect, now);
      if (mode === "city") positionTallies(now, rect);
      updateHover(rect);
    }
  }

  /* Three separate reasons to stop rendering, and all three happen often:
     the tab goes to the background, the visitor scrolls down to read the
     footer, or they leave. A city rendering at sixty frames a second behind
     a page nobody is looking at is the most common way a page like this
     spends somebody's battery. */
  let onScreen = true, awake = true;
  function setAwake() {
    const should = onScreen && !document.hidden;
    if (should === awake) return;
    awake = should;
    if (!awake) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  document.addEventListener("visibilitychange", setAwake);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => {
      onScreen = es.some((e) => e.isIntersecting);
      setAwake();
    }, { threshold: 0.02 }).observe(stage);
  }

  addEventListener("pagehide", () => {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(stripTimer); clearInterval(peekTimer); clearReleases();
    D.stop(); S.dispose(); cam.dispose(); world.dispose(true);
  });

  /* A context can still be lost for reasons that have nothing to do with us —
     a driver reset, a laptop switching GPUs, the browser reclaiming memory
     from a background tab. Saying so beats a black rectangle. */
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf); raf = 0;
    $("bootTitle").textContent = "The graphics context was lost";
    $("bootWhy").textContent = "This usually means the browser reclaimed the GPU. Reload the page to bring the city back — the live data is unaffected.";
    $("boot").hidden = false;
  });

  /* ── go ──────────────────────────────────────────────────────────────── */
  S.setEnabled(false);

  /* A "sound on" setting — which is the default, and is what a first-time
     visitor gets — is honoured from the first real gesture. Every browser
     refuses to start an audio context before one, and a page that tries is a
     page that logs a warning and stays silent anyway. The button already
     says "on", so the only thing waiting is the browser's permission.

     THE LIST IS LONG ON PURPOSE. It used to be `pointerdown` and `keydown`,
     which misses a tap that begins on the canvas and is swallowed by the
     camera's own handlers, and misses `touchend` — the event that actually
     grants activation on iOS. Anything a person can do to this page counts,
     and `once` on every one of them plus the removals means the context is
     started exactly once whichever arrives first. */
  if (soundWanted) {
    const WAKERS = ["pointerdown", "pointerup", "touchend", "keydown", "click"];
    const wake = () => {
      for (const w of WAKERS) removeEventListener(w, wake, true);
      S.setEnabled(true);
      paintMute();
    };
    /* Capture phase: a handler that calls stopPropagation on the canvas
       cannot stop this from hearing the gesture. */
    for (const w of WAKERS) addEventListener(w, wake, { capture: true, once: true });
  }
  D.start();
  raf = requestAnimationFrame(frame);
  cam.home(0);
  setTimeout(() => { $("boot").hidden = true; }, 4000);   // never hang on a slow directory

  /* Published so the tests can drive the page rather than clicking blindly at
     a canvas. Read-only handles; nothing here can post anything anywhere. */
  window.__city = {
    get level() { return level; }, get preset() { return preset; },
    get state() { return st; }, get city() { return city; },
    get tx() { return tx; }, get labels() { return labels; },
    world, cam, data: D, sound: S,
    get room3d() { return room3d; }, get mode() { return mode; }, get roomCam() { return roomCam; },
    enterRoom, leaveRoom, flyToDistrict, flyToRoom, selectAgent, selectMessage, setLevel,
    fps: () => watcher.fps(),
    /* Read-only, and published for the same reason everything else here is:
       a frame cap cannot be proved from the outside on a machine that never
       reaches it, and the test container's software renderer never does. */
    get fpsCap() { return FPS_CAP; },
  };
}

/* ── the flat road ─────────────────────────────────────────────────────── */
function startFlat(mountFlat, els) {
  document.getElementById("flat").hidden = false;      // before mount: it measures itself
  const api = mountFlat(document.getElementById("flat"), els);
  D.start();
  /* Descriptors rather than a spread, because the handle carries live getters
     and a spread would freeze them at whatever they happened to be during
     boot — which is null. */
  window.__city = Object.defineProperties(
    { flat: true, data: D },
    Object.getOwnPropertyDescriptors(api)
  );
}
