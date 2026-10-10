/**
 * GET /api/live?f=index|roster
 *
 * The home page's counters (index.json) and the Rooms page's list (roster.json),
 * read from the repository rather than from this deployment.
 *
 * WHY THIS EXISTS
 *
 * Same gap /api/recent and /api/profile close. These two files were the last
 * things a page read ONLY from the deployed copy, so they were the reason the
 * archive still had to be published (a 15-minute, ~$0.80 deployment) every
 * day. With them read here, the deployed copies are only the offline fallback
 * and the publish can be rare (see MIN_HOURS_BETWEEN_PUBLISHES in archive.yml).
 *
 * A failure answers 502 and the page falls back to the deployed file, so the
 * fallback never depends on GitHub being up.
 */

export const config = { runtime: "edge" };

const OWNER = "PranjalBoraCrypto";
const REPO = "overheard";
const BRANCH = "main";
const FILES = { index: "index.json", roster: "roster.json" };

export default async function handler(req) {
  const f = new URL(req.url).searchParams.get("f");
  const file = Object.prototype.hasOwnProperty.call(FILES, f) ? FILES[f] : null;
  if (!file) return new Response(JSON.stringify({ error: "unknown file" }), { status: 400, headers: { "Content-Type": "application/json" } });
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/${file}`, {
      headers: { Accept: "application/json", "User-Agent": "overheard-live/1.0" },
    });
    if (res.ok) {
      const body = await res.json();
      return new Response(JSON.stringify(body), {
        headers: {
          "Content-Type": "application/json",
          // 60s at the CDN: the archiver commits every ~5 minutes, so this is
          // current without asking GitHub once per visitor.
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
        },
      });
    }
  } catch { /* fall through */ }
  return new Response(JSON.stringify({ error: "unavailable" }), { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=15" } });
}
