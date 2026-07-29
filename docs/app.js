/* EventTrack — live event feed UI.
 * Reads data/events.json (produced by scripts/fetch_events.py via GitHub
 * Actions) and data/properties.json, falling back to data/sample-events.json
 * when no real feed exists yet. */

(function () {
    "use strict";

    /* ═══ SUPABASE CONFIG — same project, bucket, and shared login as
       Protest-Tracker-v2. The anon key is public by design; access control
       comes from Auth + the private bucket's RLS policy. ═══ */
    const SUPABASE_URL = "https://dkeaeprelbhdabnvcsqc.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrZWFlcHJlbGJoZGFibnZjc3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NTQ5MzcsImV4cCI6MjA5NjAzMDkzN30.Ehir5laOAKidIO8WU2yl2IoAslNqtLC3c6TVu4KJl_o";
    const SHARED_EMAIL = "lordnader2002@gmail.com";  // the single shared login account
    const DATA_BUCKET = "dashboard";                 // private Storage bucket
    const DATA_OBJECT = "live_events_data.json";

    const sb = (typeof supabase !== "undefined" && !SUPABASE_URL.includes("YOUR-PROJECT"))
        ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : null;

    const state = {
        events: [],
        properties: [],
        propertyById: new Map(),
        feed: null,
        sample: false,
        locked: false,
        authed: false,
        selectedProperty: null,
        radius: 10,
        sort: { key: null, dir: 1 },  // null key = default sort (distance)
        ovSort: { key: "property", dir: 1 },
        page: 1,
        keyword: "",
        dateFrom: "",
        dateTo: "",
        category: "",
        source: "",
        mapVisible: true,
    };

    const $ = (id) => document.getElementById(id);

    // ------------------------------------------------------------------ utils

    function haversineMiles(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function eventDate(ev) {
        return (ev.start_utc || ev.start_local || "").slice(0, 10);
    }

    function fmtWhen(ev) {
        const local = ev.start_local || ev.start_utc;
        if (!local) return "Date TBA";
        const d = new Date(local);
        if (isNaN(d)) return local;
        const opts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
        let s = d.toLocaleDateString(undefined, opts);
        if (local.length > 10) {
            s += " • " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        }
        return s;
    }

    function fmtDateShort(ev) {
        const local = ev.start_local || ev.start_utc;
        if (!local) return "TBA";
        const d = new Date(local);
        if (isNaN(d)) return local.slice(0, 10);
        return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    }

    function fmtTime(ev) {
        const local = ev.start_local || ev.start_utc;
        if (!local || local.length <= 10) return "";
        const d = new Date(local);
        if (isNaN(d)) return "";
        return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }

    function fmtPriceRange(min, max) {
        if (min == null && max == null) return "";
        if (min != null && max != null && min !== max) return `$${min} – $${max}`;
        return `$${min != null ? min : max}`;
    }

    function fmtPrice(ev) {
        return fmtPriceRange(ev.price_min, ev.price_max);
    }

    function normKey(s) {
        return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // Distance from an event to the selected property, or to its nearest
    // property when none is selected. Computed client-side so the radius
    // slider works independently of the fetch radius.
    function distanceFor(ev) {
        const v = ev.venue || {};
        if (state.selectedProperty) {
            const p = state.selectedProperty;
            return { miles: haversineMiles(v.lat, v.lon, p.lat, p.lon), property: p };
        }
        let best = null;
        for (const np of ev.nearby_properties || []) {
            if (best === null || np.distance_miles < best.miles) {
                best = { miles: np.distance_miles, property: state.propertyById.get(np.property_id) };
            }
        }
        if (best) return best;
        let min = Infinity, minProp = null;
        for (const p of state.properties) {
            const d = haversineMiles(v.lat, v.lon, p.lat, p.lon);
            if (d < min) { min = d; minProp = p; }
        }
        return { miles: min, property: minProp };
    }

    // ---------------------------------------------------------------- loading

    async function loadJson(url) {
        const resp = await fetch(url, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
        return resp.json();
    }

    // The feed comes from the private Supabase bucket when a session exists,
    // falling back to the public docs/data/events.json until the Supabase
    // secrets are configured (pre-lock mode). A stub {"locked": true} in the
    // public file means the data has moved to the bucket and login is needed.
    async function loadFeed() {
        if (sb) {
            const { data } = await sb.auth.getSession();
            if (data && data.session) {
                state.authed = true;
                const { data: blob, error } = await sb.storage.from(DATA_BUCKET).download(DATA_OBJECT);
                if (!error) return JSON.parse(await blob.text());
                console.warn("Supabase feed download failed:", error.message || error);
            }
        }
        try {
            const feed = await loadJson("data/events.json");
            if (!feed.locked) return feed;
            state.locked = true;
        } catch (e) { /* no public feed */ }
        return null;
    }

    async function loadData() {
        state.properties = await loadJson("data/properties.json");
        state.propertyById = new Map(state.properties.map((p) => [p.property_id, p]));

        let feed = await loadFeed();
        if (!feed && state.locked && sb) return;  // boot() shows the login gate

        const anyEnabled = feed && Object.values(feed.sources || {}).some((s) => s.enabled);
        if (!feed || (!feed.events.length && !anyEnabled)) {
            try {
                feed = await loadJson("data/sample-events.json");
                state.sample = true;
            } catch (e) {
                feed = feed || { generated_at: null, sources: {}, events: [] };
            }
        }
        state.sample = state.sample || !!feed.sample;
        state.feed = feed;
        state.events = feed.events || [];
        // Older feeds may carry placeholder categories from the sources.
        for (const ev of state.events) {
            if (!ev.category || /^(undefined|miscellaneous|unknown)$/i.test(ev.category)) {
                ev.category = "Other";
            }
        }
    }

    // ----------------------------------------------------------------- header

    function renderHeader() {
        const el = $("feed-status");
        const txt = $("feed-status-text");
        el.classList.remove("live", "sample");
        if (state.sample) {
            el.classList.add("sample");
            txt.textContent = "Sample data";
            $("sample-banner").classList.remove("hidden");
        } else if (state.feed.generated_at) {
            el.classList.add("live");
            const age = (Date.now() - new Date(state.feed.generated_at)) / 36e5;
            txt.textContent = `Feed updated ${age < 1 ? "under an hour" : Math.round(age) + "h"} ago`;
        } else {
            txt.textContent = "No feed available";
        }

        const badges = $("source-badges");
        badges.innerHTML = "";
        for (const [name, s] of Object.entries(state.feed.sources || {})) {
            const b = document.createElement("span");
            b.className = "source-badge" + (s.enabled ? " on" : "");
            b.textContent = name;
            b.title = s.note || (s.enabled ? `${s.events} events` : "not configured");
            badges.appendChild(b);
        }
    }

    // ---------------------------------------------------------------- filters

    function populateFilterOptions() {
        const cats = [...new Set(state.events.map((e) => e.category).filter(Boolean))].sort();
        for (const c of cats) {
            $("category").insertAdjacentHTML("beforeend",
                `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
        }
        const sources = [...new Set(state.events.map((e) => e.source))].sort();
        for (const s of sources) {
            $("source").insertAdjacentHTML("beforeend",
                `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
        }
    }

    // All non-geographic filters (keyword, category, source, date range).
    function passesFilters(ev) {
        if (state.category && ev.category !== state.category) return false;
        if (state.source && ev.source !== state.source &&
            !(ev.links && ev.links[state.source])) return false;
        const kw = state.keyword.toLowerCase();
        if (kw) {
            const hay = `${ev.title} ${ev.category} ${(ev.venue || {}).name || ""}`.toLowerCase();
            if (!hay.includes(kw)) return false;
        }
        const d = eventDate(ev);
        if (state.dateFrom && d && d < state.dateFrom) return false;
        if (state.dateTo && d && d > state.dateTo) return false;
        return true;
    }

    function filteredEvents() {
        const out = [];
        for (const ev of state.events) {
            if (!passesFilters(ev)) continue;
            const dist = distanceFor(ev);
            if (dist.miles > state.radius) continue;
            out.push({ ev, dist });
        }
        return out;
    }

    // Collapse recurring events (same title at the same venue, e.g. a week-long
    // residency) into one row carrying all of its dates.
    function groupRows(rows) {
        const groups = new Map();
        for (const r of rows) {
            const key = normKey(r.ev.title) + "|" + normKey((r.ev.venue || {}).name);
            let g = groups.get(key);
            if (!g) {
                g = { dist: r.dist, occurrences: [] };
                groups.set(key, g);
            }
            g.occurrences.push(r.ev);
            if (r.dist.miles < g.dist.miles) g.dist = r.dist;
        }
        const out = [];
        for (const g of groups.values()) {
            g.occurrences.sort((a, b) => eventDate(a).localeCompare(eventDate(b)));
            g.ev = g.occurrences[0];  // representative = first upcoming date
            g.priceMin = g.occurrences.reduce(
                (m, e) => e.price_min != null && (m == null || e.price_min < m) ? e.price_min : m, null);
            g.priceMax = g.occurrences.reduce(
                (m, e) => e.price_max != null && (m == null || e.price_max > m) ? e.price_max : m, null);
            out.push(g);
        }
        return out;
    }

    // ----------------------------------------------------------------- render

    const COLUMNS = [
        { key: "date", label: "Date / Time" },
        { key: "title", label: "Event" },
        { key: "category", label: "Category" },
        { key: "property", label: "Property" },
        { key: "distance", label: "Distance" },
        { key: "price", label: "Price" },
        { key: null, label: "Source" },
    ];

    const SORTERS = {
        date: (a, b) => eventDate(a.ev).localeCompare(eventDate(b.ev)),
        title: (a, b) => a.ev.title.localeCompare(b.ev.title),
        category: (a, b) => (a.ev.category || "").localeCompare(b.ev.category || ""),
        property: (a, b) => ((a.dist.property || {}).name || "").localeCompare((b.dist.property || {}).name || ""),
        distance: (a, b) => a.dist.miles - b.dist.miles,
        price: (a, b) => (a.priceMin ?? Infinity) - (b.priceMin ?? Infinity),
    };

    function sortRows(rows) {
        const { key, dir } = state.sort;
        if (key && SORTERS[key]) {
            rows.sort((a, b) => dir * SORTERS[key](a, b));
        } else {
            rows.sort(state.selectedProperty ? SORTERS.distance : SORTERS.date);
        }
        return rows;
    }

    function setSort(key) {
        if (state.sort.key === key) {
            state.sort.dir = -state.sort.dir;
        } else {
            state.sort = { key, dir: 1 };
        }
        state.page = 1;
        render();
    }

    const PAGE_SIZE = 50;

    // Slice rows to the current page and render the pager. Returns the slice.
    function paginate(allRows) {
        const pages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
        state.page = Math.min(Math.max(1, state.page), pages);
        const start = (state.page - 1) * PAGE_SIZE;
        const rows = allRows.slice(start, start + PAGE_SIZE);

        const pag = $("pagination");
        pag.classList.toggle("hidden", pages <= 1);
        if (pages > 1) {
            pag.innerHTML = `
                <button id="pg-prev" class="secondary" ${state.page === 1 ? "disabled" : ""}>&larr; PREV</button>
                <span class="pg-info">${start + 1}&ndash;${start + rows.length} OF ${allRows.length} &bull; PAGE ${state.page} / ${pages}</span>
                <button id="pg-next" class="secondary" ${state.page === pages ? "disabled" : ""}>NEXT &rarr;</button>`;
            $("pg-prev").addEventListener("click", () => { state.page--; render(); $("events-list").scrollIntoView({ block: "start" }); });
            $("pg-next").addEventListener("click", () => { state.page++; render(); $("events-list").scrollIntoView({ block: "start" }); });
        }
        return rows;
    }

    function render() {
        if (state.selectedProperty) renderEvents();
        else renderOverview();
    }

    // ------------------------------------------------- overview (no property)

    const OV_COLUMNS = [
        { key: "property", label: "Property" },
        { key: "events", label: "Events" },
        { key: "dates", label: "Dates" },
        { key: "closest", label: "Closest" },
        { key: "next", label: "Next Event" },
    ];

    const OV_SORTERS = {
        property: (a, b) => a.prop.name.localeCompare(b.prop.name),
        events: (a, b) => a.events - b.events,
        dates: (a, b) => a.dates - b.dates,
        closest: (a, b) => a.closest - b.closest,
        next: (a, b) => a.next.localeCompare(b.next),
    };

    function setOvSort(key) {
        if (state.ovSort.key === key) {
            state.ovSort.dir = -state.ovSort.dir;
        } else {
            state.ovSort = { key, dir: key === "events" || key === "dates" ? -1 : 1 };
        }
        state.page = 1;
        render();
    }

    // One row per property: how much is happening near it.
    function buildOverview() {
        const stats = new Map();
        for (const ev of state.events) {
            if (!passesFilters(ev)) continue;
            for (const np of ev.nearby_properties || []) {
                if (np.distance_miles > state.radius) continue;
                const prop = state.propertyById.get(np.property_id);
                if (!prop) continue;
                let s = stats.get(np.property_id);
                if (!s) {
                    s = { prop, dates: 0, groups: new Set(), closest: Infinity, next: "9999", nextEv: null };
                    stats.set(np.property_id, s);
                }
                s.dates++;
                s.groups.add(normKey(ev.title) + "|" + normKey((ev.venue || {}).name));
                if (np.distance_miles < s.closest) s.closest = np.distance_miles;
                const d = eventDate(ev);
                if (d && d < s.next) { s.next = d; s.nextEv = ev; }
            }
        }
        for (const s of stats.values()) s.events = s.groups.size;
        return [...stats.values()];
    }

    function renderOverview() {
        const allRows = buildOverview();
        allRows.sort((a, b) => state.ovSort.dir * OV_SORTERS[state.ovSort.key](a, b));
        const totalEvents = allRows.reduce((n, s) => n + s.events, 0);

        $("results-title").textContent = "All Properties — Overview";
        $("results-count").textContent =
            `${allRows.length} PROPERTIES • ${totalEvents} EVENTS • ${state.radius} MI RADIUS — SELECT A PROPERTY FOR DETAIL`;

        const list = $("events-list");
        list.innerHTML = "";
        list.classList.toggle("hidden", allRows.length === 0);
        $("empty-state").classList.toggle("hidden", allRows.length > 0);

        const rows = paginate(allRows);

        const table = document.createElement("table");
        table.className = "events-table";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const col of OV_COLUMNS) {
            const th = document.createElement("th");
            const sorted = state.ovSort.key === col.key;
            th.className = "sortable" + (sorted ? " sorted" : "");
            th.innerHTML = escapeHtml(col.label) +
                (sorted ? `<span class="arrow">${state.ovSort.dir === 1 ? "▲" : "▼"}</span>` : "");
            th.addEventListener("click", () => setOvSort(col.key));
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const s of rows) {
            const tr = document.createElement("tr");
            tr.className = "event-row";
            tr.innerHTML = `
                <td><div class="ev-title">${escapeHtml(s.prop.name)}</div>
                    <div class="ev-venue">${escapeHtml(s.prop.property_id)}</div></td>
                <td class="ev-dist">${s.events}</td>
                <td class="ev-dist">${s.dates}</td>
                <td class="ev-dist">${isFinite(s.closest) ? s.closest.toFixed(1) + " mi" : ""}</td>
                <td class="ev-when">${s.nextEv ? escapeHtml(fmtDateShort(s.nextEv)) : ""}
                    <div class="ev-venue">${s.nextEv ? escapeHtml(s.nextEv.title) : ""}</div></td>`;
            tr.addEventListener("click", () => selectProperty(s.prop));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        list.appendChild(table);

        // Map shows every event and sizes property dots by activity —
        // independent of list pagination.
        rebuildPropertyMarkers(new Map(allRows.map((s) => [s.prop.property_id, s.events])));
        updateMap(groupRows(filteredEvents()), true);
    }

    // -------------------------------------------- event list (property view)

    function renderEvents() {
        const allRows = sortRows(groupRows(filteredEvents()));
        const dates = allRows.reduce((n, g) => n + g.occurrences.length, 0);
        $("results-title").textContent = `${state.selectedProperty.name} — Nearby Events`;
        $("results-count").textContent =
            `${allRows.length} EVENT${allRows.length === 1 ? "" : "S"}` +
            (dates > allRows.length ? ` (${dates} DATES)` : "") +
            ` • ${state.radius} MI RADIUS` +
            (state.sort.key ? "" : " • CLOSEST FIRST");

        const list = $("events-list");
        list.innerHTML = "";
        list.classList.toggle("hidden", allRows.length === 0);
        $("empty-state").classList.toggle("hidden", allRows.length > 0);

        const rows = paginate(allRows);
        rebuildPropertyMarkers(null);

        const table = document.createElement("table");
        table.className = "events-table";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const col of COLUMNS) {
            const th = document.createElement("th");
            const sorted = col.key && state.sort.key === col.key;
            th.className = (col.key ? "sortable" : "") + (sorted ? " sorted" : "");
            th.innerHTML = escapeHtml(col.label) +
                (sorted ? `<span class="arrow">${state.sort.dir === 1 ? "▲" : "▼"}</span>` : "");
            if (col.key) th.addEventListener("click", () => setSort(col.key));
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const group of rows) {
            const { ev, dist, occurrences } = group;
            const v = ev.venue || {};
            const tr = document.createElement("tr");
            tr.className = "event-row";
            const prop = dist.property;
            const more = occurrences.length > 1
                ? `<div class="ev-more">+${occurrences.length - 1} more date${occurrences.length > 2 ? "s" : ""}</div>`
                : "";
            tr.innerHTML = `
                <td class="ev-when">${escapeHtml(fmtDateShort(ev))}<div class="ev-time">${escapeHtml(fmtTime(ev))}</div>${more}</td>
                <td><div class="ev-title">${escapeHtml(ev.title)}</div>
                    <div class="ev-venue">${escapeHtml(v.name || "")}${v.city ? " • " + escapeHtml(v.city) : ""}${v.state ? ", " + escapeHtml(v.state) : ""}</div></td>
                <td class="nowrap"><span class="cat-tag">${escapeHtml(ev.category || "Event")}</span></td>
                <td class="ev-prop">${prop ? escapeHtml(prop.name) : ""}</td>
                <td class="ev-dist">${isFinite(dist.miles) ? dist.miles.toFixed(1) + " mi" : ""}</td>
                <td class="ev-price">${escapeHtml(fmtPriceRange(group.priceMin, group.priceMax))}</td>
                <td class="ev-src">${escapeHtml(ev.source)}</td>`;
            tr.addEventListener("click", () => showModal(group));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        list.appendChild(table);

        updateMap(allRows);  // full set, not just the current page
    }

    // -------------------------------------------------------------------- map

    let map = null;
    let eventLayer = null;
    let propertyLayer = null;
    let radiusCircle = null;
    let canvasRenderer = null;

    function initMap() {
        if (typeof L === "undefined") {
            // Leaflet failed to load (offline / blocked) — degrade to list-only.
            $("map-container").style.display = "none";
            $("view-toggle").style.display = "none";
            return;
        }
        map = L.map("map", { scrollWheelZoom: true }).setView([39.8283, -98.5795], 4);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19,
        }).addTo(map);
        // Canvas rendering keeps thousands of markers fast.
        canvasRenderer = L.canvas({ padding: 0.5 });
        propertyLayer = L.layerGroup().addTo(map);
        eventLayer = L.layerGroup().addTo(map);
        rebuildPropertyMarkers(null);
    }

    // Property dots. With a count map (overview), dot size reflects how many
    // events are near the property; zero-event properties are dimmed.
    function rebuildPropertyMarkers(countById) {
        if (!map) return;
        propertyLayer.clearLayers();
        for (const p of state.properties) {
            const count = countById ? (countById.get(p.property_id) || 0) : null;
            const quiet = count === 0;
            L.circleMarker([p.lat, p.lon], {
                renderer: canvasRenderer,
                radius: count ? Math.min(13, 4 + Math.sqrt(count)) : 4,
                color: "#d92d2d", weight: 1.5,
                fillColor: "#d92d2d",
                fillOpacity: quiet ? 0.15 : 0.6,
                opacity: quiet ? 0.35 : 1,
            }).bindTooltip(`${p.name} (${p.property_id})` +
                    (count != null ? ` — ${count} event${count === 1 ? "" : "s"}` : ""))
              .on("click", () => selectProperty(p))
              .addTo(propertyLayer);
        }
    }

    function updateMap(rows, aggregateByVenue) {
        if (!map) return;
        eventLayer.clearLayers();
        if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }

        const bounds = [];
        if (aggregateByVenue) {
            // Overview: one marker per venue, sized by event count. Far fewer
            // layers than per-event markers, which matters at feed scale.
            const venues = new Map();
            for (const g of rows) {
                const v = g.ev.venue || {};
                if (v.lat == null) continue;
                const key = v.lat.toFixed(4) + "," + v.lon.toFixed(4);
                let s = venues.get(key);
                if (!s) {
                    s = { lat: v.lat, lon: v.lon, name: v.name || "Venue", count: 0 };
                    venues.set(key, s);
                }
                s.count++;
            }
            for (const s of venues.values()) {
                L.circleMarker([s.lat, s.lon], {
                    renderer: canvasRenderer,
                    radius: Math.min(11, 4 + Math.sqrt(s.count)),
                    color: "#fbbf24", weight: 1.5,
                    fillColor: "#fbbf24", fillOpacity: 0.35,
                }).bindTooltip(`${s.name} — ${s.count} event${s.count === 1 ? "" : "s"}`)
                  .addTo(eventLayer);
                bounds.push([s.lat, s.lon]);
            }
        } else {
            for (const group of rows) {
                const { ev } = group;
                const v = ev.venue || {};
                if (v.lat == null) continue;
                const extra = group.occurrences.length > 1 ? ` (+${group.occurrences.length - 1} more dates)` : "";
                L.circleMarker([v.lat, v.lon], {
                    renderer: canvasRenderer,
                    radius: 6, color: "#fbbf24", weight: 1.5,
                    fillColor: "#fbbf24", fillOpacity: 0.35,
                }).bindTooltip(`${ev.title} — ${fmtWhen(ev)}${extra}`)
                  .on("click", () => showModal(group))
                  .addTo(eventLayer);
                bounds.push([v.lat, v.lon]);
            }
        }

        if (state.selectedProperty) {
            const p = state.selectedProperty;
            radiusCircle = L.circle([p.lat, p.lon], {
                radius: state.radius * 1609.34,
                color: "#d92d2d", weight: 1, fillOpacity: 0.05,
            }).addTo(map);
            map.fitBounds(radiusCircle.getBounds(), { padding: [24, 24] });
        }
        // Overview keeps the current view — auto-fitting to all markers zooms
        // out to include Hawaii/Alaska and shrinks the continental US.
    }

    // ------------------------------------------------------------------ modal

    function showModal(group) {
        const { ev, dist } = group;
        const occurrences = group.occurrences || [ev];
        const v = ev.venue || {};
        const priceMin = group.priceMin !== undefined ? group.priceMin : ev.price_min;
        const priceMax = group.priceMax !== undefined ? group.priceMax : ev.price_max;
        const price = fmtPriceRange(priceMin, priceMax);
        const when = occurrences.length > 1
            ? `${occurrences.length} dates • ${fmtDateShort(occurrences[0])} – ${fmtDateShort(occurrences[occurrences.length - 1])}`
            : fmtWhen(ev);
        $("modal-title").textContent = ev.title;
        $("modal-meta").innerHTML = `
            <div><strong>When</strong> ${escapeHtml(when)}</div>
            <div><strong>Venue</strong> ${escapeHtml(v.name || "Unknown")}${v.address ? " — " + escapeHtml(v.address) : ""}${v.city ? ", " + escapeHtml(v.city) : ""}${v.state ? ", " + escapeHtml(v.state) : ""}</div>
            ${price ? `<div><strong>Tickets</strong> ${escapeHtml(price)}</div>` : ""}
            <div><strong>Category</strong> ${escapeHtml(ev.category || "Event")}</div>
            <div><strong>Source</strong> ${escapeHtml(ev.source)}</div>`;

        const datesSection = $("modal-dates-section");
        const datesList = $("modal-dates");
        datesList.innerHTML = "";
        datesSection.classList.toggle("hidden", occurrences.length <= 1);
        for (const occ of occurrences) {
            const links = occ.links || (occ.url ? { [occ.source]: occ.url } : {});
            const linkHtml = Object.entries(links)
                .filter(([, url]) => url)
                .map(([src, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(src)} ↗</a>`)
                .join(" ");
            datesList.insertAdjacentHTML("beforeend",
                `<li><span>${escapeHtml(fmtWhen(occ))}</span><span class="date-links">${linkHtml}</span></li>`);
        }

        const ul = $("modal-properties");
        ul.innerHTML = "";
        const nearby = (ev.nearby_properties && ev.nearby_properties.length)
            ? ev.nearby_properties
            : (dist.property ? [{ property_id: dist.property.property_id, distance_miles: +dist.miles.toFixed(1) }] : []);
        for (const np of nearby.slice(0, 8)) {
            const p = state.propertyById.get(np.property_id);
            ul.insertAdjacentHTML("beforeend",
                `<li><span>${escapeHtml(p ? p.name : np.property_id)}</span>` +
                `<span class="mono">${np.distance_miles} mi</span></li>`);
        }

        const links = $("modal-links");
        links.innerHTML = "";
        const linkMap = ev.links || (ev.url ? { [ev.source]: ev.url } : {});
        for (const [src, url] of Object.entries(linkMap)) {
            if (!url) continue;
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = `View on ${src.charAt(0).toUpperCase() + src.slice(1)} ↗`;
            links.appendChild(a);
        }

        $("event-modal").classList.remove("hidden");
    }

    // ------------------------------------------------------- property picker

    function selectProperty(p) {
        state.selectedProperty = p;
        state.page = 1;
        $("property-search").value = "";
        $("property-results").classList.add("hidden");
        $("property-chip-name").textContent = `${p.name} (${p.property_id})`;
        $("property-chip").classList.remove("hidden");
        render();
    }

    function clearProperty() {
        state.selectedProperty = null;
        state.page = 1;
        $("property-chip").classList.add("hidden");
        if (map) map.setView([39.8283, -98.5795], 4);
        render();
    }

    function setupPropertySearch() {
        const input = $("property-search");
        const results = $("property-results");
        input.addEventListener("input", () => {
            const q = input.value.trim().toLowerCase();
            results.innerHTML = "";
            if (!q) { results.classList.add("hidden"); return; }
            const matches = state.properties.filter((p) =>
                p.name.toLowerCase().includes(q) ||
                p.property_id.toLowerCase().includes(q) ||
                (p.address || "").toLowerCase().includes(q)).slice(0, 12);
            for (const p of matches) {
                const row = document.createElement("div");
                row.innerHTML = `${escapeHtml(p.name)} <span class="pr-id">${escapeHtml(p.property_id)}</span>`;
                row.addEventListener("mousedown", () => selectProperty(p));
                results.appendChild(row);
            }
            results.classList.toggle("hidden", matches.length === 0);
        });
        input.addEventListener("blur", () => setTimeout(() => results.classList.add("hidden"), 150));
    }

    // ------------------------------------------------------------------ wires

    function setupControls() {
        const setFilter = (fn) => (e) => { fn(e); state.page = 1; render(); };
        let radiusTimer = null;
        $("radius").addEventListener("input", (e) => {
            state.radius = +e.target.value;
            $("radius-value").textContent = state.radius;
            state.page = 1;
            clearTimeout(radiusTimer);  // debounce: full re-render is heavy
            radiusTimer = setTimeout(render, 150);
        });
        $("keyword").addEventListener("input", setFilter((e) => { state.keyword = e.target.value.trim(); }));
        $("date-from").addEventListener("change", setFilter((e) => { state.dateFrom = e.target.value; }));
        $("date-to").addEventListener("change", setFilter((e) => { state.dateTo = e.target.value; }));
        $("category").addEventListener("change", setFilter((e) => { state.category = e.target.value; }));
        $("source").addEventListener("change", setFilter((e) => { state.source = e.target.value; }));
        $("property-clear").addEventListener("click", clearProperty);
        $("reset-filters").addEventListener("click", () => {
            state.keyword = state.dateFrom = state.dateTo = state.category = state.source = "";
            state.radius = 10;
            state.sort = { key: null, dir: 1 };
            $("keyword").value = $("date-from").value = $("date-to").value = "";
            $("category").value = $("source").value = "";
            $("radius").value = 10;
            $("radius-value").textContent = "10";
            clearProperty();
        });
        $("view-toggle").addEventListener("click", () => {
            state.mapVisible = !state.mapVisible;
            $("map-container").style.display = state.mapVisible ? "" : "none";
            $("view-toggle").textContent = state.mapVisible ? "HIDE MAP" : "SHOW MAP";
            if (state.mapVisible && map) map.invalidateSize();
        });
        $("modal-close").addEventListener("click", () => $("event-modal").classList.add("hidden"));
        $("event-modal").addEventListener("click", (e) => {
            if (e.target === $("event-modal")) $("event-modal").classList.add("hidden");
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") $("event-modal").classList.add("hidden");
        });
    }

    // ------------------------------------------------------------------ auth

    function showLoginGate() {
        $("feed-status-text").textContent = "Sign in required";
        $("login-overlay").classList.remove("hidden");
        $("login-password").focus();
    }

    async function doLogin() {
        const pw = $("login-password").value;
        if (!pw) return;
        const err = $("login-error");
        err.classList.add("hidden");
        $("login-btn").disabled = true;
        try {
            const { error } = await sb.auth.signInWithPassword({ email: SHARED_EMAIL, password: pw });
            if (error) throw new Error(error.message || "Sign-in failed");
            location.reload();  // session is persisted; reload boots authenticated
        } catch (e) {
            err.textContent = /invalid/i.test(e.message) ? "Incorrect password." : e.message;
            err.classList.remove("hidden");
            $("login-btn").disabled = false;
        }
    }

    function setupAuth() {
        $("login-btn").addEventListener("click", doLogin);
        $("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
        $("sign-out").addEventListener("click", async () => {
            if (sb) await sb.auth.signOut();
            location.reload();
        });
    }

    // ------------------------------------------------------------------- boot

    async function boot() {
        setupAuth();
        try {
            await loadData();
        } catch (e) {
            $("feed-status-text").textContent = "Failed to load data: " + e.message;
            return;
        }
        if (state.locked && !state.feed) {
            showLoginGate();
            return;
        }
        if (state.authed) $("sign-out").classList.remove("hidden");
        renderHeader();
        populateFilterOptions();
        setupPropertySearch();
        setupControls();
        try {
            initMap();
        } catch (e) {
            console.error("map init failed, continuing without map:", e);
            $("map-container").style.display = "none";
        }
        render();
    }

    boot();
})();
