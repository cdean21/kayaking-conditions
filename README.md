# Carrum Kayaking Conditions — Cloudflare backend (MVP)

This is an initial **data collection and candidate-scoring backend**, not a certified marine safety or operational alerting service. It deliberately marks all opportunities as **unverified** until official warnings, live observations, entrance notices and tide checks are integrated.

## Deploy

Requires Node.js and a Cloudflare account with Workers and D1.

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create kayaking-conditions`
4. Copy the returned `database_id` into `wrangler.jsonc`.
5. `npx wrangler d1 migrations apply kayaking-conditions --remote`
6. Set a secret for manual refresh: `npx wrangler secret put ADMIN_TOKEN`
7. `npm run deploy`

## Test

- `GET /api/health` — service check
- `GET /api/sites` — sampling coordinates
- `GET /api/status` — last collection status
- `GET /api/opportunities` — modelled candidate windows
- `GET /api/events` — recorded changes
- `POST /api/run` with `Authorization: Bearer <ADMIN_TOKEN>` — collect now

The hourly UTC cron evaluates the **Melbourne** local clock, running at **7 AM and 3 PM weekdays**, and **7 AM, 11 AM and 3 PM weekends** (automatically accommodating daylight saving).

## Included

- Open-Meteo hourly weather forecasts at both approximate launch locations.
- Open-Meteo marine forecast at one approximate offshore sample point.
- Activity-specific sustained-wind preferences: fishing <=10 kn, kayaking <=12 kn, sailing 8–20 kn.
- Provisional gust/wave/rain/daylight filters and two-hour minimum window.
- D1 forecast history, opportunities and change events.
- No external notifications are sent yet. Existing ChatGPT automations are separate and do not automatically read this Worker.

## Critical limitations / next phase

- **Do not treat candidate opportunities as a green light to launch.** No official marine-warning feed is yet connected. The model can miss hazardous conditions.
- Wind/gust/wave thresholds beyond the user's stated sustained-wind preferences are provisional and should be reviewed.
- The wave model's offshore sample is **not** a measured Carrum beach or Patterson River entrance wave condition.
- No reliable local tide/current data, Fawkner Beacon live observations, or Parks Victoria notices are ingested yet.
- Opportunity keys use the start hour; large timing shifts can be classified as new rather than changed. A future matcher should track overlapping windows.
- Forecast snapshots are stored in full JSON; add retention/pruning as history grows.
- Add authentication to read endpoints before using sensitive or user-specific data; current read endpoints are public.
- Add an authenticated delivery integration (e.g. email, push or webhook) with deduplication once official warning gating is implemented.

## Pushover iPhone lock-screen notifications

1. Install **Pushover** on your iPhone and enable notifications (including Lock Screen).
2. Register/login at https://pushover.net and copy your **User Key**.
3. Create an application at https://pushover.net/apps/build named `Carrum Kayaking Conditions Watch` and copy its **API Token**.
4. From this project folder, add secrets (never put these in `wrangler.jsonc` or commit them):

   ```bash
   npx wrangler secret put PUSHOVER_USER_KEY
   npx wrangler secret put PUSHOVER_APP_TOKEN
   ```

5. Deploy with `npm run deploy`.
6. Test using your existing `ADMIN_TOKEN` and Worker URL:

   ```bash
   curl -X POST 'https://YOUR-WORKER.workers.dev/api/pushover/test' \
     -H 'Authorization: Bearer YOUR_ADMIN_TOKEN'
   ```

   This sends a clearly labelled **test notification** to the iPhone.

7. **Optional:** To enable real event delivery, set `ALERTS_ENABLED` to `"true"` in `wrangler.jsonc` and deploy. At present, only deterioration/cancellation alerts are eligible for automatic delivery. **Positive opportunity alerts remain blocked** because official marine warning and local entrance safety checks have not been integrated. A successful Pushover test does not validate the marine scoring engine.

Delivery status is stored in the existing `tbl_alert_events.delivery_status` field. Failed Pushover calls cause the run to error and leave the event pending for retry. No extra D1 migration is required.

## Fishing enrichment (v0.2)

New module `src/fishing.js` and migration `migrations/0002_fishing.sql` add:
- `GET /api/fishing/species` — preferred table targets (flathead, calamari, snapper, whiting) and Australian salmon as sport target.
- `GET /api/fishing/moon?at=2026-10-10T00:00:00Z` — approximate lunar phase and illumination. This does **not** calculate moonrise, moonset, lunar overhead/underfoot or tide heights.
- `GET /api/fishing/outlook` — per-species provisional scores for already-stored fishing opportunities. Scores are heuristic, not catch probabilities; no live fishing reports are implied.
- D1 tables `tbl_fishing_trips`, `tbl_catches`, `tbl_fishing_preferences` for future authenticated catch logging. No public write endpoints are provided yet.

Seasonal months are preliminary heuristics for Port Phillip, not evidence of fish presence on a particular day. No fishing regulations are embedded; always consult current Victorian Fisheries Authority guidance. Fishing quality cannot override unverified marine safety. Run all D1 migrations when deploying via Wrangler.

## Fishing enrichment (next iteration)

New `src/fishing-enrichment.js` adds Open-Meteo modelled sea-surface temperature and modelled sea level. Temperature contributes only a weak provisional +/- score adjustment. Sea level is never represented as an official tide prediction. `GET /api/fishing/sources` documents provenance and links to BOM Victorian tide tables. `migrations/0003_fishing_enrichment.sql` reserves a provenance-aware table for manually verified BOM high/low tide events; this build does not automatically ingest official tides, lunar rise/set or lunar transit, and does not activate positive safety notifications.

Deploy with the new source module alongside the updated `src/worker.js` and `src/fishing.js`. Apply D1 migration 0003 after previous migrations. All timestamps in the Open-Meteo fetch use UTC; the app renders Melbourne-local times. Do not publish `ADMIN_TOKEN` or Pushover credentials.

## Fishing dashboard, astronomical moon times, and verified tide import (v0.4)

- Install dependencies with `npm install` before deploying; the Worker now imports `suncalc` (2.x).
- Visit `/` or `/dashboard` for the mobile-friendly read-only dashboard. It displays moonrise/set, moon overhead/underfoot, sunrise/sunset, species priorities, provisional fishing windows, and any imported verified tide events.
- `GET /api/fishing/moon?at=2026-10-10T02:00:00Z` uses the Carrum coordinates and Melbourne local civil day for SunCalc lunar and solar events. These are astronomical approximations, not evidence of feeding activity.
- `GET /api/fishing/tides` reads manually verified high/low events from `tbl_verified_tides` (migration 0003). No tide values are prefilled or fabricated.
- `POST /api/fishing/tides` accepts `Authorization: Bearer ADMIN_TOKEN` and JSON `{ "events": [{"reference_station":"Melbourne (Williamstown)","event_at":"<ISO timestamp with timezone>","event_type":"high or low","height_m":<number>,"datum":"<datum from PDF>","source_name":"BOM National Tidal Unit","source_url":"https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml","source_year":2026}] }`. Only transcribe verified BOM PDF values; the server checks input format/provenance labels but **cannot verify the numbers**. Do not use Williamstown tides as Patterson River entrance navigation advice.
- This release does **not** add an automated PDF ingestion pipeline, catch log write UI, or a marine safety clearance system. Positive launch alerts remain blocked.

## Species bite timeline (October 2026 update)

New `src/bite-timeline.js` generates an hourly species-suitability timeline from the latest successfully stored Open-Meteo weather and marine forecast snapshot. `GET /api/fishing/timeline?site=carrum-foreshore` or `?site=patterson-river` returns the next 72 hours. The dashboard now provides a launch-site and target-species selector and hour-by-hour details.

- **Species:** flathead, southern calamari, snapper/pinkies, King George whiting and Australian salmon. Scores are *uncalibrated heuristics*, not probability of catching fish.
- **Temperature:** Open-Meteo numerical sea-surface-temperature prediction, clearly labelled as modelled rather than observed.
- **Clarity:** no invented clarity measurements. A wind/wave/rain proxy can flag *possible stirring*; otherwise clarity remains undetermined.
- **Tides:** displays the nearest manually imported, source-verified BOM Williamstown high/low tide event within six hours. Does not infer a Patterson River tide, entrance current or navigational water level. No event means unavailable.
- **Moon:** approximate SunCalc phase, illumination, moonrise, moonset, transit and lower transit; shown as context, not a validated catch predictor.
- **Confidence:** heuristic measure of data completeness and forecast age, capped at 75/100 until independent safety data is integrated. Not a measure of forecast accuracy or launch safety.
- **Safety:** all hours have `launch_status: 'unverified'`. High bite scores cannot clear official marine warnings, thunderstorms or unsafe entrance conditions. Positive Pushover opportunity alerts remain disabled.

**Deploy:** add `src/bite-timeline.js` and replace `src/worker.js`, `src/dashboard.js` and this README. No new D1 migration is required; existing `0001` through `0003` must already be applied. Run `npm install`, then `npm run deploy` on your Mac. Run the protected `POST /api/run` endpoint or wait for a scheduled collection to populate the timeline. Do not put Pushover credentials in source control.

**Testing:** JavaScript syntax checks have passed. Live Cloudflare, API, astronomical and forecast integration testing is still outstanding.

## Official marine feed integration (October 2026)

- New `src/official-marine.js` fetches BOM's official **Victoria marine warnings RSS** (`https://www.bom.gov.au/fwo/IDZ00073.warnings_marine_vic.xml`) on each forecast run. The parser checks feed structure, item URLs and warning metadata. Results, including feed errors, are persisted to `tbl_official_marine_checks` (migration `0004_official_marine.sql`). `GET /api/official/marine` exposes the latest check with direct BOM links.
- RSS is **supplementary only** and can include warnings outside Carrum. It cannot verify that Port Phillip is warning-free, or account for thunderstorms, entrance hazards, or changing conditions. Any RSS fetch failure is explicitly recorded as `unavailable`. **Positive Pushover alerts remain disabled**; neither a blank RSS feed nor a successfully fetched feed is a safety clearance.
- Verified tide predictions still require transcription from the official BOM **Melbourne (Williamstown)** PDF into the authenticated `/api/fishing/tides` endpoint. The importer now requires timezone-qualified timestamps, plausible numeric heights, a valid year and consistent source metadata. It does **not** independently verify the transcribed tide heights, automatically download the PDF, or model Patterson River entrance currents. BOM tide tables include daylight saving adjustments; enter the actual Melbourne offset for each event.
- Apply D1 migration `0004` **before** running this Worker. No secrets were added to source code.
- Test `GET /api/official/marine`, then the protected `POST /api/run`. Verify that RSS errors fail closed and that the response still shows `safety_verified:false`. Full end-to-end live testing remains outstanding.

## Decoupled BOM ingestion

The hourly scheduled handler refreshes BOM FTP products into `tbl_bom_snapshots`. `/api/run` never performs FTP I/O; it reads the latest validated snapshot and blocks positive alerts when that snapshot is missing or stale. An authenticated `POST /api/bom/refresh` endpoint is available for manual ingestion tests. BOM FTP refresh attempts are bounded to 10 seconds.

## BOM marine ingestion via GitHub Actions

Direct FTP from the Cloudflare Worker is intentionally not used. `.github/workflows/bom-marine-ingest.yml` runs every 30 minutes and can also be run manually. It downloads `IDV20600.xml` and `IDV10460.xml` from the Bureau of Meteorology anonymous FTP service, then sends them to the protected Worker endpoint `/api/bom/ingest`. The Worker independently validates product IDs, issue/expiry times, the Port Phillip zone `VIC_MW005`, and stores only a validated snapshot in D1.

Create one random secret and set the same value in both places:

```bash
openssl rand -hex 32
npx wrangler secret put BOM_INGEST_TOKEN
```

Then in the GitHub repository add an Actions repository secret named `BOM_INGEST_TOKEN` with that same value. Do not commit the token. After deployment, run the `BOM marine ingest` workflow manually once to populate D1; scheduled runs then occur at minutes 07 and 37 each hour.

## Official BOM Williamstown tides (reviewed import)

BOM publishes annual 2026/2027 Melbourne (Williamstown) tide PDFs at
https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml .
**This release does not automatically parse PDF tables or claim that tide data has been imported.**
For accuracy, transcribe/check the official PDF into a CSV with headers:
`local_date,local_time,event_type,height_m,source_year`.
Use BOM's printed local time (AEDT/AEST as applicable), heights in metres above LAT,
`high`/`low`, and the correct year. No example rows are provided because sample numbers
could be mistaken for real predictions.

Run `python3 tools/import_verified_tides.py path/to/reviewed.csv` to validate and preview.
Then set ADMIN_TOKEN securely in your shell and run
`python3 tools/import_verified_tides.py path/to/reviewed.csv --send`.
The script imports batches of 100 through the existing authenticated endpoint;
no D1 migration is required. It rejects duplicate timestamps, unexpected tide ordering,
large gaps and ambiguous/nonexistent Melbourne DST times. The Worker also validates
station, provenance, year and timestamp. Verify imported values against the original PDF.

The graph now indicates reference-station **rising/falling** between adjacent verified
high/low extrema and displays verified tide height when available. This is not a
measurement or prediction of Patterson River entrance currents or water levels.
BOM tide data is copyright Commonwealth of Australia, Bureau of Meteorology.
This product is based on Bureau of Meteorology information that has subsequently been
modified. The Bureau does not necessarily support or endorse, or have any connection
with, this product. BOM makes no warranty as to availability, accuracy, currency,
completeness, quality, reliability or fitness for purpose and excludes liability for
loss or damage arising from reliance on the information, to the maximum extent permitted by law.
Official source and full terms: https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml

## Official Williamstown tide PDF extraction (2026)

Official source: https://www.bom.gov.au/ntc/IDO59001/IDO59001_2026_VIC_TP003.pdf

The source is an annual PDF, **not a live tide feed**. Its predictions are for
Melbourne (Williamstown), not the Patterson River entrance. They are not live
water-level or current observations. Predictions use local Melbourne time,
including daylight saving, and heights are metres above LAT.

1. Download the official PDF from the source URL to the project directory as `williamstown_2026.pdf`.
2. Install PDF extraction dependency: `python3 -m pip install pdfplumber`.
3. Run `python3 tools/extract_bom_williamstown.py williamstown_2026.pdf --out williamstown_2026_REVIEW.csv`.
4. **Do not import on extraction failure.** The PDF layout parser is provided for
   local verification and has not been end-to-end tested against the actual PDF
   in this build environment. If it fails, inspect the PDF/CSV and adjust the
   parser, rather than fabricating missing predictions.
5. Compare at least several dates per month (especially daylight-saving
   transition dates) against the official PDF. Run
   `python3 tools/import_verified_tides.py williamstown_2026_REVIEW.csv`
   for validation (dry run).
6. Once the PDF values are verified, run
   `read -s ADMIN_TOKEN; export ADMIN_TOKEN` then
   `python3 tools/import_verified_tides.py williamstown_2026_REVIEW.csv --send`.
   Clear the shell variable afterward: `unset ADMIN_TOKEN`.
7. Test `/api/fishing/tides` and the hourly graph tooltips. Do not treat tide
   predictions as launch clearance. Keep alerts disabled.

**BOM attribution and conditions:** Copyright Commonwealth of Australia,
Bureau of Meteorology. This product is based on Bureau of Meteorology
information that has subsequently been modified. The Bureau does not
necessarily support or endorse, or have any connection with, this product.
The Bureau makes no warranty regarding availability, accuracy, currency,
completeness, quality or reliability, and excludes liability for loss arising
from use of or reliance on the information, to the extent permitted by law.
See the complete official conditions of use at
https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml .

## Automated launch screening
`GET /api/launch-assessment?site=carrum-foreshore&activity=fishing` combines the latest validated BOM Port Phillip warning snapshot, Parks Victoria local-notice snapshot, and the nearest stored local weather/marine forecast hour. It returns `passed`, `caution`, `blocked`, or `incomplete`. `launch_verified` deliberately remains false: actual shore break/river entrance state, currents and rapidly changing on-water conditions must still be checked at the site. Positive alerts remain blocked while `ALERTS_ENABLED=false`.
