# vendor

Third-party code, committed rather than fetched at runtime.

## three.module.min.js — three.js r169, MIT

Loaded by /city and by nothing else. It is vendored rather than pulled from a
CDN for two reasons: a CDN outage would take the page down for everyone at
once, and a script this size arriving from a third party is a supply-chain
surface the rest of this site does not have. 687 KB raw, ~170 KB over the
wire; it is behind a dynamic import, so no other page pays for it.

Licence: `three.LICENSE.txt` (MIT, © 2010-2024 three.js authors).
Upgrade by replacing the file — nothing here patches it.
