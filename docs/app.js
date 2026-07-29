/* EventTrack — live event feed UI.
 * Reads data/events.json (produced by scripts/fetch_events.py via GitHub
 * Actions) and data/properties.json, falling back to data/sample-events.json
 * when no real feed exists yet. */

(function () {
    "use strict";

    const state = {
        events: [],
        properties: [],
        propertyById: new Map(),
        feed: null,
        sample: false,
        selectedProperty: null,
        radius: 15,
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

    function fmtPrice(ev) {
        if (ev.price_min == null && ev.price_max == null) return "";
        if (ev.price_min != null && ev.price_max != null && ev.price_min !== ev.price_max) {
            return `$${ev.price_min} – $${ev.price_max}`;
        }
        return `$${ev.price_min != null ? ev.price_min : ev.price_max}`;
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

    async function loadData() {
        state.properties = await loadJson("data/properties.json");
        state.propertyById = new Map(state.properties.map((p) => [p.property_id, p]));

        let feed = null;
        try {
            feed = await loadJson("data/events.json");
        } catch (e) { /* no real feed yet */ }

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

    function filteredEvents() {
        const kw = state.keyword.toLowerCase();
        const out = [];
        for (const ev of state.events) {
            const dist = distanceFor(ev);
            if (dist.miles > state.radius) continue;
            if (state.category && ev.category !== state.category) continue;
            if (state.source && ev.source !== state.source &&
                !(ev.links && ev.links[state.source])) continue;
            if (kw) {
                const hay = `${ev.title} ${ev.category} ${(ev.venue || {}).name || ""}`.toLowerCase();
                if (!hay.includes(kw)) continue;
            }
            const d = eventDate(ev);
            if (state.dateFrom && d && d < state.dateFrom) continue;
            if (state.dateTo && d && d > state.dateTo) continue;
            out.push({ ev, dist });
        }
        out.sort(state.selectedProperty
            ? (a, b) => a.dist.miles - b.dist.miles
            : (a, b) => eventDate(a.ev).localeCompare(eventDate(b.ev)));
        return out;
    }

    // ----------------------------------------------------------------- render

    function render() {
        const rows = filteredEvents();
        $("results-title").textContent = state.selectedProperty
            ? `${state.selectedProperty.name} — Nearby Events`
            : "All Properties — Event Feed";
        $("results-count").textContent =
            `${rows.length} EVENT${rows.length === 1 ? "" : "S"} • ${state.radius} MI RADIUS`;

        const grid = $("events-grid");
        grid.innerHTML = "";
        $("empty-state").classList.toggle("hidden", rows.length > 0);

        for (const { ev, dist } of rows) {
            const v = ev.venue || {};
            const card = document.createElement("div");
            card.className = "event-card";
            const distLabel = dist.property
                ? `${dist.miles.toFixed(1)} mi • ${escapeHtml(dist.property.property_id)}`
                : "";
            card.innerHTML = `
                <div class="card-top">
                    <span class="cat-tag">${escapeHtml(ev.category || "Event")}</span>
                    <span class="dist-tag">${distLabel}</span>
                </div>
                <h3>${escapeHtml(ev.title)}</h3>
                <p class="when">${escapeHtml(fmtWhen(ev))}</p>
                <p class="where">${escapeHtml(v.name || "")}${v.city ? " • " + escapeHtml(v.city) : ""}${v.state ? ", " + escapeHtml(v.state) : ""}</p>
                <div class="card-foot">
                    <span>${escapeHtml(fmtPrice(ev))}</span>
                    <span class="src">${escapeHtml(ev.source)}</span>
                </div>`;
            card.addEventListener("click", () => showModal(ev, dist));
            grid.appendChild(card);
        }

        updateMap(rows);
    }

    // -------------------------------------------------------------------- map

    let map = null;
    let eventLayer = null;
    let propertyLayer = null;
    let radiusCircle = null;

    function initMap() {
        if (typeof L === "undefined") {
            // Leaflet failed to load (offline / blocked) — degrade to list-only.
            $("map-container").style.display = "none";
            $("view-toggle").style.display = "none";
            return;
        }
        map = L.map("map", { scrollWheelZoom: false }).setView([39.8283, -98.5795], 4);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19,
        }).addTo(map);
        propertyLayer = L.layerGroup().addTo(map);
        eventLayer = L.layerGroup().addTo(map);

        for (const p of state.properties) {
            L.circleMarker([p.lat, p.lon], {
                radius: 4, color: "#d92d2d", weight: 1.5,
                fillColor: "#d92d2d", fillOpacity: 0.6,
            }).bindTooltip(`${p.name} (${p.property_id})`)
              .on("click", () => selectProperty(p))
              .addTo(propertyLayer);
        }
    }

    function updateMap(rows) {
        if (!map) return;
        eventLayer.clearLayers();
        if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }

        const bounds = [];
        for (const { ev } of rows) {
            const v = ev.venue || {};
            if (v.lat == null) continue;
            L.circleMarker([v.lat, v.lon], {
                radius: 7, color: "#fbbf24", weight: 2,
                fillColor: "#fbbf24", fillOpacity: 0.35,
            }).bindTooltip(`${ev.title} — ${fmtWhen(ev)}`)
              .on("click", () => showModal(ev, distanceFor(ev)))
              .addTo(eventLayer);
            bounds.push([v.lat, v.lon]);
        }

        if (state.selectedProperty) {
            const p = state.selectedProperty;
            radiusCircle = L.circle([p.lat, p.lon], {
                radius: state.radius * 1609.34,
                color: "#d92d2d", weight: 1, fillOpacity: 0.05,
            }).addTo(map);
            map.fitBounds(radiusCircle.getBounds(), { padding: [24, 24] });
        } else if (bounds.length) {
            map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10 });
        }
    }

    // ------------------------------------------------------------------ modal

    function showModal(ev, dist) {
        const v = ev.venue || {};
        $("modal-title").textContent = ev.title;
        $("modal-meta").innerHTML = `
            <div><strong>When</strong> ${escapeHtml(fmtWhen(ev))}</div>
            <div><strong>Venue</strong> ${escapeHtml(v.name || "Unknown")}${v.address ? " — " + escapeHtml(v.address) : ""}${v.city ? ", " + escapeHtml(v.city) : ""}${v.state ? ", " + escapeHtml(v.state) : ""}</div>
            ${fmtPrice(ev) ? `<div><strong>Tickets</strong> ${escapeHtml(fmtPrice(ev))}</div>` : ""}
            <div><strong>Category</strong> ${escapeHtml(ev.category || "Event")}</div>
            <div><strong>Source</strong> ${escapeHtml(ev.source)}</div>`;

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
        $("property-search").value = "";
        $("property-results").classList.add("hidden");
        $("property-chip-name").textContent = `${p.name} (${p.property_id})`;
        $("property-chip").classList.remove("hidden");
        render();
    }

    function clearProperty() {
        state.selectedProperty = null;
        $("property-chip").classList.add("hidden");
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
        $("radius").addEventListener("input", (e) => {
            state.radius = +e.target.value;
            $("radius-value").textContent = state.radius;
            render();
        });
        $("keyword").addEventListener("input", (e) => { state.keyword = e.target.value.trim(); render(); });
        $("date-from").addEventListener("change", (e) => { state.dateFrom = e.target.value; render(); });
        $("date-to").addEventListener("change", (e) => { state.dateTo = e.target.value; render(); });
        $("category").addEventListener("change", (e) => { state.category = e.target.value; render(); });
        $("source").addEventListener("change", (e) => { state.source = e.target.value; render(); });
        $("property-clear").addEventListener("click", clearProperty);
        $("reset-filters").addEventListener("click", () => {
            state.keyword = state.dateFrom = state.dateTo = state.category = state.source = "";
            state.radius = 15;
            $("keyword").value = $("date-from").value = $("date-to").value = "";
            $("category").value = $("source").value = "";
            $("radius").value = 15;
            $("radius-value").textContent = "15";
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

    // ------------------------------------------------------------------- boot

    async function boot() {
        try {
            await loadData();
        } catch (e) {
            $("feed-status-text").textContent = "Failed to load data: " + e.message;
            return;
        }
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
