/**
 * GET /api/recent
 *
 * The "seen recently" strip, read from the repository rather than from this
 * deployment.
 *
 * WHY THIS EXISTS
 *
 * Same gap /api/profile closes, and it shows up worse here. The archiver
 * commits recent.json every ~5 minutes; the site DEPLOYS twice an hour. The
 * page was reading the deployed copy, so a section whose entire claim is
 * "straight out of the archive" was routinely announcing that it had last
 * collected anything 40 minutes ago — which reads as abandoned, whatever the
 * truth is.
 *
 * Reading the same file from raw.githubusercontent.com cuts the wait to the
 * commit cadence. The deployed file under /data stays exactly where it is and
 * stays the fallback: if GitHub is unreachable the strip still fills, just
 * with older lines, and it says so.
 */

export const config = { runtime: "edge" };

const OWNER = "PranjalBoraCrypto";
const REPO = "overheard";
const BRANCH = "main";
const SRC = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/recent.json`;

export default async function handler() {
  let body = null;
  try {
    const res = await fetch(SRC, {
      headers: { Accept: "application/json", "User-Agent": "overheard-recent/1.0" },
    });
    if (res.ok) body = await res.json();
  } catch { /* fall through — the page still has the deployed copy */ }

  if (!body) {
    return new Response(JSON.stringify({ source: "unavailable", dids: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, s-maxage=30",
      },
    });
  }

  return new Response(JSON.stringify({ ...body, source: "repository" }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // 30s at the CDN. The archiver cannot produce anything new faster than
      // that, so a shorter window would only add upstream requests, and a
      // longer one would put the staleness back.
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
    },
  });
}
