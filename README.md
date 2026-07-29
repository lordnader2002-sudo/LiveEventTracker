# LiveEventTracker

Tracks live events (concerts, sports, festivals, conventions) happening near our
mall properties, so operations teams can anticipate traffic and staffing impact.

- **Data pipeline** — `scripts/fetch_events.py` queries the Ticketmaster,
  SeatGeek, Eventbrite and StubHub APIs for events within a radius of every
  property in `data/properties.csv` and writes a normalized feed to
  `docs/data/events.json`.
- **Automation** — the *Fetch events* GitHub Actions workflow runs the pipeline
  every morning at 6am ET (plus on demand) and commits the updated feed.
- **UI** — `docs/` is a static site (GitHub Pages-ready): searchable property
  picker, radius/date/category/source/keyword filters, event cards, detail
  modal, and a Leaflet map showing properties and events.

Until API keys are configured the UI runs on bundled **sample data** and shows a
banner saying so — nothing breaks, you just see fixtures instead of real events.

## Setup

### 1. Add API keys as repository secrets

*Settings → Secrets and variables → Actions → New repository secret.* Every
source is optional — the pipeline uses whichever keys exist and skips the rest.

| Secret | Where to get it | Notes |
|---|---|---|
| `TICKETMASTER_API_KEY` | [developer.ticketmaster.com](https://developer.ticketmaster.com) — free, instant | **Recommended first key.** Discovery API, 5 000 calls/day free tier, best geo search of the four. |
| `SEATGEEK_CLIENT_ID` (+ optional `SEATGEEK_CLIENT_SECRET`) | [seatgeek.com/account/develop](https://seatgeek.com/account/develop) — free | Good geo search and price stats. |
| `EVENTBRITE_API_TOKEN` | [eventbrite.com/platform](https://www.eventbrite.com/platform/) | ⚠️ Eventbrite **retired its public event-search API in 2019**. A token only surfaces events from your own Eventbrite organizations; it cannot search all public events near a point. |
| `STUBHUB_CLIENT_ID` / `STUBHUB_CLIENT_SECRET` | [developer.stubhub.com](https://developer.stubhub.com) | Requires an approved **partner account**; the adapter is best-effort and skips cleanly if auth fails. StubHub inventory heavily overlaps Ticketmaster/SeatGeek anyway (it's a resale market). |

Practical guidance: **Ticketmaster + SeatGeek cover the real-world need.**
Eventbrite and StubHub adapters are wired up but limited by those platforms'
API policies, which the feed's per-source status makes visible in the UI header.

### 2. Run the pipeline once

*Actions → Fetch events → Run workflow.* It fetches all sources, writes
`docs/data/events.json` + `docs/data/properties.json`, and commits them.
Scheduled (cron) runs only fire on the **default branch**. The schedule is
daily at 10:00 UTC — 6am ET during daylight saving time, 5am ET in winter
(GitHub cron has no DST awareness).

### 3. Enable GitHub Pages

*Settings → Pages → Source: **GitHub Actions***. The *Deploy UI to GitHub
Pages* workflow publishes `docs/` on every push to `main` that touches it,
and also after every successful *Fetch events* run — so the daily data
refresh republishes the site automatically.

## Configuration

Environment variables read by `scripts/fetch_events.py` (also exposed as inputs
on the manual workflow run):

| Variable | Default | Meaning |
|---|---|---|
| `RADIUS_MILES` | `10` | Search radius around each property |
| `LOOKAHEAD_DAYS` | `60` | How far into the future to search |
| `MAX_PROPERTIES` | `0` (all) | Limit properties processed — handy for testing |

## Local development

```bash
pip install requests

# Full fetch (uses whatever API keys are in your environment):
TICKETMASTER_API_KEY=... python scripts/fetch_events.py

# Or regenerate the sample fixture feed:
python scripts/fetch_events.py --sample

# Serve the UI:
python -m http.server 8000 --directory docs
# open http://localhost:8000
```

## Data model

`docs/data/events.json`:

```jsonc
{
  "generated_at": "2026-07-29T05:00:00Z",
  "config": { "radius_miles": 15, "lookahead_days": 60 },
  "sources": { "ticketmaster": { "enabled": true, "events": 812, "errors": 0, "note": "" }, ... },
  "event_count": 812,
  "events": [
    {
      "id": "tm:XYZ123",
      "source": "ticketmaster",
      "title": "Example Concert",
      "category": "Music",
      "start_utc": "2026-08-01T23:00:00Z",
      "start_local": "2026-08-01T19:00:00",
      "venue": { "name": "...", "address": "...", "city": "...", "state": "...", "lat": 0, "lon": 0 },
      "url": "https://...",
      "price_min": 49.5, "price_max": 199.5,
      "links": { "ticketmaster": "https://...", "seatgeek": "https://..." },
      "nearby_properties": [ { "property_id": "ROOSEVELT", "distance_miles": 3.2 } ]
    }
  ]
}
```

The same event found on multiple platforms is merged (matching title + date +
venue within 2 miles) with all ticket links kept under `links`. An event within
range of several properties lists each of them in `nearby_properties`.

## Repository layout

```
data/properties.csv              # 213 properties (id, name, address, lat/lon)
scripts/fetch_events.py          # pipeline: fetch → normalize → dedupe → JSON
docs/                            # static UI (GitHub Pages)
  index.html / app.js / styles.css
  data/events.json               # generated feed (committed by the workflow)
  data/properties.json           # generated from the CSV
  data/sample-events.json        # fixture feed used before keys exist
.github/workflows/fetch-events.yml
.github/workflows/deploy-pages.yml
```

## Roadmap / notes for the Design phase

- The prototype's "threat assessment" panel was dropped — none of the ticketing
  APIs provide risk data. If wanted later, it needs its own scoring model
  (attendance estimates, venue capacity, time-of-day overlap with mall hours).
- Possible next steps: per-property email digests, expected-attendance
  enrichment (venue capacity datasets), calendar (ICS) export, and CSV export.
