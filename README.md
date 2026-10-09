# BMO2026 NHL Pool Tracker — 2026–27

Updated build with one-trade-per-entry transactions, admin controls, live roster analytics, NHL sync health, and original inline-SVG hockey artwork.

## Included
- 27 locked draft slots per entry.
- One trade per entry, any time during the regular season.
- Trade replacement must come from the exact same original pool-sheet slot.
- Old pick keeps points earned through the trade; new pick starts at zero and earns only afterward.
- Trade is refused when the last NHL snapshot is more than 10 minutes old.
- Admin passphrase defaults to `bmo2026admin` and can be overridden with `ADMIN_PASSPHRASE`.
- Admin can toggle paid/unpaid, undo active trades, and fix unmatched NHL player spellings.
- Regular-season-only NHL Stats API queries: season `20262027`, game type `2`.
- No NHL request is made before `seasonStart`; no preseason/playoff data is counted.
- Daily 06:00 America/Toronto scheduled snapshot plus manual refresh.
- Last good snapshot remains visible if NHL.com/API is unavailable.
- Historical snapshots power the cumulative trend chart.
- Pool-by-the-numbers reads the same live roster data as standings.
- Original inline SVG hockey emblem; no team logos or copyrighted artwork.

## Scoring loaded from the supplied BMO2026 sheet
Forwards: G = 2, A = 1
Defencemen: G = 2, A = 1
Goalies: W = 2, SO = 2, OTL = 1
Teams: W = 2, OTL = 1

## Run
```bash
npm install
npm start
```
Then open http://localhost:3000.

## Environment variables
- `PORT` — default `3000`
- `ADMIN_PASSPHRASE` — default `bmo2026admin`
- `REFRESH_TOKEN` — optional secret for POST `/api/refresh`
- `NHL_API_BASE` — optional, defaults to `https://api.nhle.com/stats/rest/en`

## Persistent storage
SQLite is stored in `pool.db`. For a public deployment, attach a persistent disk/volume so trades, paid status, name mappings, and historical snapshots survive redeploys.

## Imported roster count
The currently supplied roster data contains **19 participant entries**. The UI computes roster statistics dynamically from whatever participant data is loaded, so if the intended final pool is 9 entries, replace `data/participants.json` and `data/rosters.json` with the nine final entries and the numbers section will automatically reflect 9 × 27 = 243 spots.


## October 9, 2026 roster/scoring repair

This package incorporates the latest uploaded pool spreadsheet while preserving the original draft roster/slot-option rules. The active spreadsheet rows seed the latest standings snapshot; replaced rows are imported as historical trades:
- 19 participants and exactly 27 active roster slots each (513 total).
- Rows released before April 10, 2027 are excluded from the current standings and represented in `data/seed-trades.json` where they were replaced by another player in the same participant/slot.
- Scoring is aligned to the spreadsheet totals: skater/defenceman goals = 1, assists = 1; goalie wins/shutouts/overtime losses = 1 each; franchise wins/overtime losses = 1 each.
- Season window is inclusive: September 29, 2026 through April 10, 2027.
- `data/seed-snapshot.json` contains the latest spreadsheet standings as a fallback. On startup, the app installs this fallback if the stored snapshot has stale rosters, then attempts an NHL API refresh. If the NHL stats API returns no skater/goalie rows or is unavailable, the app retains the last good snapshot.
- Franchise/team matching supports NHL team abbreviations and full team names, and logs franchise-pick match counts during sync.

Deploy by replacing the repository contents with the contents of this package (files at the ZIP root), committing to `main`, and letting Render deploy. Do not upload the ZIP as `server.js`; extract it first.
