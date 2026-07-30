#!/usr/bin/env python3
"""Fetch live events happening near company properties.

Queries the Ticketmaster, SeatGeek, Eventbrite and StubHub APIs for events
within RADIUS_MILES of every property in data/properties.csv, normalizes the
results into a single schema, and writes docs/data/events.json for the UI.

Every source is optional: an adapter runs only when its credentials are
present in the environment, so the script always exits 0 and produces a
valid (possibly empty) feed.

Credentials (set as GitHub Actions secrets / local env vars):
    TICKETMASTER_API_KEY
    SEATGEEK_CLIENT_ID, SEATGEEK_CLIENT_SECRET (secret optional)
    EVENTBRITE_API_TOKEN
    STUBHUB_CLIENT_ID, STUBHUB_CLIENT_SECRET

Tuning (env vars):
    RADIUS_MILES     search radius around each property (default 5)
    LOOKAHEAD_DAYS   how far into the future to search (default 30)
    MAX_PROPERTIES   limit properties processed, 0 = all (for testing)

Usage:
    python scripts/fetch_events.py            # full fetch
    python scripts/fetch_events.py --sample   # write sample-events.json fixture
"""

import csv
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    print("ERROR: the 'requests' package is required: pip install requests", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
PROPERTIES_CSV = ROOT / "data" / "properties.csv"
OUT_DIR = ROOT / "docs" / "data"

RADIUS_MILES = float(os.environ.get("RADIUS_MILES", "5"))
LOOKAHEAD_DAYS = int(os.environ.get("LOOKAHEAD_DAYS", "30"))
MAX_PROPERTIES = int(os.environ.get("MAX_PROPERTIES", "0"))

USER_AGENT = "LiveEventTracker/1.0 (property operations event feed)"


# --------------------------------------------------------------------------- helpers

def log(msg):
    print(msg, flush=True)


def haversine_miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def load_properties():
    props = []
    with open(PROPERTIES_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                props.append({
                    "property_id": row["property_id"].strip(),
                    "name": row["name"].strip(),
                    "address": row["address"].strip(),
                    "postal_code": (row.get("postal_code") or "").strip(),
                    "lat": float(row["lat"]),
                    "lon": float(row["lon"]),
                    "oic": (row.get("oic") or "").strip().upper() in ("TRUE", "1", "YES"),
                })
            except (KeyError, ValueError) as e:
                log(f"WARN: skipping bad property row {row!r}: {e}")
    return props


class Http:
    """Small requests wrapper with retry/backoff and a per-host rate limit."""

    def __init__(self, min_interval=0.25):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.min_interval = min_interval
        self._last = 0.0

    def get(self, url, **kwargs):
        for attempt in range(4):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                resp = self.session.get(url, timeout=30, **kwargs)
            except requests.RequestException as e:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == 3:
                    resp.raise_for_status()
                retry_after = resp.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after else 2 ** attempt)
                continue
            return resp
        raise RuntimeError("unreachable")


def norm_title(title):
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def clean_category(name):
    """Some sources return placeholder categories (Ticketmaster literally says
    "Undefined" for uncategorized events) — collapse those to "Other"."""
    name = (name or "").strip()
    if not name or name.lower() in ("undefined", "miscellaneous", "unknown"):
        return "Other"
    return name


# --------------------------------------------------------------------------- adapters
#
# Each adapter yields normalized event dicts:
#   {id, source, title, category, start_utc, start_local, venue{name,address,
#    city, lat, lon}, url, price_min, price_max}
# nearby_properties is attached afterwards by attach_properties().


def fetch_ticketmaster(props, window_start, window_end, status):
    api_key = os.environ.get("TICKETMASTER_API_KEY")
    if not api_key:
        status["enabled"] = False
        status["note"] = "TICKETMASTER_API_KEY not set — skipped"
        return
    status["enabled"] = True
    http = Http(min_interval=0.25)  # stay under the default 5 req/s quota
    seen = set()
    for prop in props:
        params = {
            "apikey": api_key,
            "latlong": f"{prop['lat']},{prop['lon']}",
            "radius": str(int(math.ceil(RADIUS_MILES))),
            "unit": "miles",
            "startDateTime": window_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endDateTime": window_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "size": "200",
            "sort": "date,asc",
        }
        try:
            resp = http.get("https://app.ticketmaster.com/discovery/v2/events.json", params=params)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            status["errors"] += 1
            log(f"WARN: ticketmaster query failed for {prop['property_id']}: {e}")
            continue
        for ev in (data.get("_embedded") or {}).get("events", []):
            if ev.get("id") in seen or ev.get("test"):
                continue
            seen.add(ev.get("id"))
            venues = (ev.get("_embedded") or {}).get("venues") or [{}]
            v = venues[0]
            loc = v.get("location") or {}
            try:
                vlat, vlon = float(loc["latitude"]), float(loc["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            dates = (ev.get("dates") or {}).get("start") or {}
            classification = (ev.get("classifications") or [{}])[0]
            segment = (classification.get("segment") or {}).get("name")
            prices = ev.get("priceRanges") or []
            yield {
                "id": f"tm:{ev['id']}",
                "source": "ticketmaster",
                "title": ev.get("name", "Untitled event"),
                "category": clean_category(segment),
                "start_utc": dates.get("dateTime"),
                "start_local": dates.get("localDate", "") + ("T" + dates["localTime"] if dates.get("localTime") else ""),
                "venue": {
                    "name": v.get("name", "Unknown venue"),
                    "address": (v.get("address") or {}).get("line1", ""),
                    "city": (v.get("city") or {}).get("name", ""),
                    "state": (v.get("state") or {}).get("stateCode", ""),
                    "lat": vlat,
                    "lon": vlon,
                },
                "url": ev.get("url", ""),
                "price_min": min((p.get("min") for p in prices if p.get("min") is not None), default=None),
                "price_max": max((p.get("max") for p in prices if p.get("max") is not None), default=None),
            }


def fetch_seatgeek(props, window_start, window_end, status):
    client_id = os.environ.get("SEATGEEK_CLIENT_ID")
    if not client_id:
        status["enabled"] = False
        status["note"] = "SEATGEEK_CLIENT_ID not set — skipped"
        return
    status["enabled"] = True
    http = Http(min_interval=0.25)
    seen = set()
    base_params = {"client_id": client_id}
    secret = os.environ.get("SEATGEEK_CLIENT_SECRET")
    if secret:
        base_params["client_secret"] = secret
    for prop in props:
        page, max_pages = 1, 3
        while page <= max_pages:
            params = dict(base_params,
                          lat=prop["lat"], lon=prop["lon"],
                          range=f"{int(math.ceil(RADIUS_MILES))}mi",
                          per_page=100, page=page,
                          **{"datetime_utc.gte": window_start.strftime("%Y-%m-%dT%H:%M:%S"),
                             "datetime_utc.lte": window_end.strftime("%Y-%m-%dT%H:%M:%S")})
            try:
                resp = http.get("https://api.seatgeek.com/2/events", params=params)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                status["errors"] += 1
                log(f"WARN: seatgeek query failed for {prop['property_id']} p{page}: {e}")
                break
            events = data.get("events", [])
            for ev in events:
                if ev.get("id") in seen:
                    continue
                seen.add(ev.get("id"))
                v = ev.get("venue") or {}
                loc = v.get("location") or {}
                if loc.get("lat") is None or loc.get("lon") is None:
                    continue
                stats = ev.get("stats") or {}
                taxonomies = ev.get("taxonomies") or []
                category = (taxonomies[0].get("name", "other").replace("_", " ").title()
                            if taxonomies else (ev.get("type") or "other").replace("_", " ").title())
                yield {
                    "id": f"sg:{ev['id']}",
                    "source": "seatgeek",
                    "title": ev.get("title", "Untitled event"),
                    "category": clean_category(category),
                    "start_utc": (ev.get("datetime_utc") + "Z") if ev.get("datetime_utc") else None,
                    "start_local": ev.get("datetime_local"),
                    "venue": {
                        "name": v.get("name", "Unknown venue"),
                        "address": v.get("address") or "",
                        "city": v.get("city") or "",
                        "state": v.get("state") or "",
                        "lat": float(loc["lat"]),
                        "lon": float(loc["lon"]),
                    },
                    "url": ev.get("url", ""),
                    "price_min": stats.get("lowest_price"),
                    "price_max": stats.get("highest_price"),
                }
            total = (data.get("meta") or {}).get("total", 0)
            if page * 100 >= total or not events:
                break
            page += 1


def fetch_eventbrite(props, window_start, window_end, status):
    """Eventbrite retired its public event-search API in 2019, so a general
    "events near a point" query is no longer possible. If a token is present
    we pull events from the token owner's own organizations (the only listing
    the current API supports) and keep the ones near a property."""
    token = os.environ.get("EVENTBRITE_API_TOKEN")
    if not token:
        status["enabled"] = False
        status["note"] = "EVENTBRITE_API_TOKEN not set — skipped"
        return
    status["enabled"] = True
    status["note"] = ("Eventbrite's public search API was retired in 2019; "
                      "only events from your own Eventbrite organizations are included.")
    http = Http(min_interval=0.5)
    headers = {"Authorization": f"Bearer {token}"}
    try:
        resp = http.get("https://www.eventbriteapi.com/v3/users/me/organizations/", headers=headers)
        resp.raise_for_status()
        orgs = resp.json().get("organizations", [])
    except Exception as e:
        status["errors"] += 1
        log(f"WARN: eventbrite organizations lookup failed: {e}")
        return
    for org in orgs:
        page = 1
        while True:
            try:
                resp = http.get(
                    f"https://www.eventbriteapi.com/v3/organizations/{org['id']}/events/",
                    headers=headers,
                    params={"status": "live", "expand": "venue,category", "page": page},
                )
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                status["errors"] += 1
                log(f"WARN: eventbrite events lookup failed for org {org.get('id')}: {e}")
                break
            for ev in data.get("events", []):
                v = ev.get("venue") or {}
                try:
                    vlat, vlon = float(v["latitude"]), float(v["longitude"])
                except (KeyError, TypeError, ValueError):
                    continue
                start = ev.get("start") or {}
                addr = v.get("address") or {}
                yield {
                    "id": f"eb:{ev['id']}",
                    "source": "eventbrite",
                    "title": ((ev.get("name") or {}).get("text")) or "Untitled event",
                    "category": clean_category((ev.get("category") or {}).get("name")),
                    "start_utc": start.get("utc"),
                    "start_local": start.get("local"),
                    "venue": {
                        "name": v.get("name", "Unknown venue"),
                        "address": addr.get("address_1", ""),
                        "city": addr.get("city", ""),
                        "state": addr.get("region", ""),
                        "lat": vlat,
                        "lon": vlon,
                    },
                    "url": ev.get("url", ""),
                    "price_min": None,
                    "price_max": None,
                }
            if not (data.get("pagination") or {}).get("has_more_items"):
                break
            page += 1


def fetch_stubhub(props, window_start, window_end, status):
    """StubHub's Catalog API requires an approved partner account. Best-effort:
    client-credentials OAuth against the account endpoint, then a geo search
    per property. Skipped cleanly when credentials are absent or rejected."""
    client_id = os.environ.get("STUBHUB_CLIENT_ID")
    client_secret = os.environ.get("STUBHUB_CLIENT_SECRET")
    if not client_id or not client_secret:
        status["enabled"] = False
        status["note"] = "STUBHUB_CLIENT_ID/SECRET not set — skipped (requires StubHub partner account)"
        return
    status["enabled"] = True
    http = Http(min_interval=0.5)
    try:
        resp = http.session.post(
            "https://account.stubhub.com/oauth2/token",
            data={"grant_type": "client_credentials", "scope": "read:events"},
            auth=(client_id, client_secret),
            timeout=30,
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]
    except Exception as e:
        status["errors"] += 1
        status["note"] = f"StubHub OAuth failed ({e}); check partner credentials"
        log(f"WARN: stubhub auth failed: {e}")
        return
    headers = {"Authorization": f"Bearer {token}"}
    seen = set()
    for prop in props:
        params = {
            "point": f"{prop['lat']},{prop['lon']}",
            "radius": int(math.ceil(RADIUS_MILES)),
            "units": "mi",
            "min_date": window_start.strftime("%Y-%m-%dT%H:%M:%S"),
            "max_date": window_end.strftime("%Y-%m-%dT%H:%M:%S"),
            "page_size": 100,
        }
        try:
            resp = http.get("https://api.stubhub.net/catalog/events", headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            status["errors"] += 1
            log(f"WARN: stubhub query failed for {prop['property_id']}: {e}")
            if status["errors"] >= 5:
                status["note"] = "StubHub queries failing repeatedly — aborted for this run"
                return
            continue
        for ev in data.get("_embedded", {}).get("items", data.get("events", [])):
            if ev.get("id") in seen:
                continue
            seen.add(ev.get("id"))
            v = ev.get("_embedded", {}).get("venue", ev.get("venue") or {})
            try:
                vlat = float(v.get("latitude") or v.get("lat"))
                vlon = float(v.get("longitude") or v.get("lon"))
            except (TypeError, ValueError):
                continue
            yield {
                "id": f"sh:{ev['id']}",
                "source": "stubhub",
                "title": ev.get("name", "Untitled event"),
                "category": clean_category((ev.get("categories") or [{}])[0].get("name")
                                           if isinstance(ev.get("categories"), list) else None),
                "start_utc": ev.get("event_datetime_utc") or ev.get("eventDateUTC"),
                "start_local": ev.get("event_datetime_local") or ev.get("eventDateLocal"),
                "venue": {
                    "name": v.get("name", "Unknown venue"),
                    "address": v.get("address1", ""),
                    "city": v.get("city", ""),
                    "state": v.get("state", ""),
                    "lat": vlat,
                    "lon": vlon,
                },
                "url": ev.get("web_uri") or ev.get("webURI") or "",
                "price_min": (ev.get("ticket_info") or {}).get("min_list_price"),
                "price_max": (ev.get("ticket_info") or {}).get("max_list_price"),
            }


ADAPTERS = [
    ("ticketmaster", fetch_ticketmaster),
    ("seatgeek", fetch_seatgeek),
    ("eventbrite", fetch_eventbrite),
    ("stubhub", fetch_stubhub),
]


# --------------------------------------------------------------------------- pipeline

def attach_properties(event, props):
    nearby = []
    for prop in props:
        d = haversine_miles(event["venue"]["lat"], event["venue"]["lon"], prop["lat"], prop["lon"])
        if d <= RADIUS_MILES:
            nearby.append({"property_id": prop["property_id"], "distance_miles": round(d, 1)})
    nearby.sort(key=lambda n: n["distance_miles"])
    event["nearby_properties"] = nearby
    return bool(nearby)


def dedupe_cross_source(events):
    """Collapse the same real-world event reported by multiple sources.
    Conservative match: identical normalized title + same calendar date +
    venues within 2 miles. The first-seen record wins; other sources'
    ticket links are kept in `links`."""
    merged = []
    index = {}
    for ev in events:
        date = (ev.get("start_utc") or ev.get("start_local") or "")[:10]
        key = (norm_title(ev["title"]), date)
        kept = None
        for candidate in index.get(key, []):
            if haversine_miles(ev["venue"]["lat"], ev["venue"]["lon"],
                               candidate["venue"]["lat"], candidate["venue"]["lon"]) <= 2:
                kept = candidate
                break
        if kept:
            kept["links"][ev["source"]] = ev["url"]
            if kept.get("price_min") is None:
                kept["price_min"], kept["price_max"] = ev.get("price_min"), ev.get("price_max")
        else:
            ev["links"] = {ev["source"]: ev["url"]}
            index.setdefault(key, []).append(ev)
            merged.append(ev)
    return merged


def write_properties_json(props):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "properties.json"
    out.write_text(json.dumps(props, indent=1), encoding="utf-8")
    log(f"Wrote {out} ({len(props)} properties)")


def run_fetch():
    props = load_properties()
    if MAX_PROPERTIES:
        props = props[:MAX_PROPERTIES]
    log(f"Loaded {len(props)} properties; radius={RADIUS_MILES}mi lookahead={LOOKAHEAD_DAYS}d")
    write_properties_json(props)

    window_start = datetime.now(timezone.utc).replace(microsecond=0)
    window_end = window_start + timedelta(days=LOOKAHEAD_DAYS)

    all_events = []
    sources = {}
    for name, adapter in ADAPTERS:
        status = {"enabled": False, "events": 0, "errors": 0, "note": ""}
        sources[name] = status
        started = time.monotonic()
        try:
            for ev in adapter(props, window_start, window_end, status) or []:
                if attach_properties(ev, props):
                    all_events.append(ev)
                    status["events"] += 1
        except Exception as e:
            status["errors"] += 1
            status["note"] = f"adapter crashed: {e}"
            log(f"ERROR: {name} adapter crashed: {e}")
        if status["enabled"]:
            log(f"{name}: {status['events']} events, {status['errors']} errors "
                f"({time.monotonic() - started:.0f}s)")
        else:
            log(f"{name}: skipped ({status['note']})")

    events = dedupe_cross_source(all_events)
    events.sort(key=lambda e: e.get("start_utc") or e.get("start_local") or "9999")
    log(f"Total: {len(all_events)} raw events -> {len(events)} after cross-source dedupe")

    feed = {
        "generated_at": window_start.isoformat().replace("+00:00", "Z"),
        "config": {"radius_miles": RADIUS_MILES, "lookahead_days": LOOKAHEAD_DAYS},
        "sources": sources,
        "event_count": len(events),
        "events": events,
    }
    out = OUT_DIR / "events.json"
    out.write_text(json.dumps(feed, indent=1), encoding="utf-8")
    log(f"Wrote {out}")

    if not any(s["enabled"] for s in sources.values()):
        log("NOTE: no API credentials configured — feed is empty. "
            "See README.md for how to add API keys as repository secrets.")


# --------------------------------------------------------------------------- sample data

def run_sample():
    """Write a realistic fixture feed so the UI works before API keys exist."""
    props = {p["property_id"]: p for p in load_properties()}
    write_properties_json(list(props.values()))
    now = datetime.now(timezone.utc).replace(microsecond=0)

    def near(pid, dlat, dlon):
        p = props[pid]
        return p["lat"] + dlat, p["lon"] + dlon

    fixtures = [
        ("Kenny Chesney: Sun Goes Down Tour", "Music", "ROOSEVELT", 0.02, -0.01,
         "UBS Arena", "Belmont Park", "Elmont", "NY", 5, "ticketmaster", 79.5, 350.0),
        ("New York Knicks vs. Boston Celtics", "Sports", "ROOSEVELT", -0.09, -0.13,
         "Madison Square Garden", "4 Pennsylvania Plaza", "New York", "NY", 12, "seatgeek", 120.0, 890.0),
        ("Disney On Ice presents Magic in the Stars", "Family", "GRAPEVINE", 0.03, 0.02,
         "Dickies Arena", "1911 Montgomery St", "Fort Worth", "TX", 8, "ticketmaster", 25.0, 95.0),
        ("Bad Bunny — Most Wanted Tour", "Music", "DOLPHIN", 0.04, 0.05,
         "Kaseya Center", "601 Biscayne Blvd", "Miami", "FL", 21, "stubhub", 150.0, 1200.0),
        ("Chicago Food Truck Festival", "Festival", "WOODFIELDM", 0.01, 0.01,
         "Busse Woods Forest Preserve", "Higgins Rd", "Elk Grove Village", "IL", 15, "eventbrite", 10.0, 10.0),
        ("Monster Jam", "Sports", "CONCORD", 0.005, 0.01,
         "Charlotte Motor Speedway", "5555 Concord Pkwy S", "Concord", "NC", 30, "ticketmaster", 20.0, 75.0),
        ("Sabrina Carpenter: Short n' Sweet Tour", "Music", "LENOX", -0.02, 0.03,
         "State Farm Arena", "1 State Farm Dr", "Atlanta", "GA", 9, "seatgeek", 89.0, 425.0),
        ("Comic Con Community Expo", "Convention", "VEGASCONVENTION", 0.0, 0.002,
         "Las Vegas Convention Center", "3150 Paradise Rd", "Las Vegas", "NV", 18, "eventbrite", 45.0, 145.0),
        ("Phoenix Suns vs. LA Lakers", "Sports", "ARZMILLS", 0.08, 0.06,
         "Footprint Center", "201 E Jefferson St", "Phoenix", "AZ", 4, "seatgeek", 60.0, 510.0),
        ("Trans-Siberian Orchestra", "Music", "KATYMILLS", 0.11, 0.14,
         "NRG Stadium", "1 NRG Pkwy", "Houston", "TX", 40, "ticketmaster", 49.5, 199.5),
    ]

    events = []
    for i, (title, cat, pid, dlat, dlon, vname, vaddr, vcity, vstate,
            days_out, source, pmin, pmax) in enumerate(fixtures):
        lat, lon = near(pid, dlat, dlon)
        start = (now + timedelta(days=days_out)).replace(hour=23, minute=30)
        ev = {
            "id": f"sample:{i}",
            "source": source,
            "title": title,
            "category": cat,
            "start_utc": start.isoformat().replace("+00:00", "Z"),
            "start_local": (start - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S"),
            "venue": {"name": vname, "address": vaddr, "city": vcity, "state": vstate,
                      "lat": round(lat, 5), "lon": round(lon, 5)},
            "url": "https://example.com/sample-event",
            "price_min": pmin,
            "price_max": pmax,
            "links": {source: "https://example.com/sample-event"},
        }
        attach_properties(ev, list(props.values()))
        events.append(ev)

    feed = {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "config": {"radius_miles": RADIUS_MILES, "lookahead_days": LOOKAHEAD_DAYS},
        "sources": {name: {"enabled": True, "events": sum(1 for e in events if e["source"] == name),
                           "errors": 0, "note": "sample fixture"} for name, _ in ADAPTERS},
        "sample": True,
        "event_count": len(events),
        "events": events,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "sample-events.json"
    out.write_text(json.dumps(feed, indent=1), encoding="utf-8")
    log(f"Wrote {out} ({len(events)} sample events)")


if __name__ == "__main__":
    if "--sample" in sys.argv:
        run_sample()
    else:
        run_fetch()
