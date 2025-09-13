// /* script.js — Rewritten core logic for Track My Bus
//    - One marker per bus, one timeline per bus
//    - Smooth movement along real roads (OSRM) with fallback to straight segments
//    - ETA updates and "Arrived" marking when within threshold
//    - Populate From/To dropdowns reliably
//    - No old setInterval jumpers, no duplicate timelines/markers
//    - Requires: Leaflet included in HTML, an element #map, selects #fromSelect & #toSelect,
//      #trackBtn button, and #timeline-wrap container in HTML, and bus.png in same folder
//    - Serve over http(s) (Live Server or GitHub Pages) for OSRM fetches to work. */


// Ask notification permission on load
if ("Notification" in window && Notification.permission !== "granted") {
  Notification.requestPermission();
}

// Preload sound for notifications
const notifySound = new Audio("notify.mp3"); // add a notify.mp3 in your project folder


/* ===========================
   Configuration & Routes
   =========================== */

// You can replace/extend ROUTES below with your full routes dataset.
const ROUTES = {
  "Bus 101": {
    color: "#e74c3c",
    stops: [
      { name: "Golden Temple", coords: [31.6200, 74.8765] },
      { name: "Hall Bazaar",   coords: [31.6270, 74.8750] },
      { name: "Ram Bagh",      coords: [31.6315, 74.8778] },
      { name: "Railway Station", coords: [31.6340, 74.8790] },
      { name: "Bus Stand",     coords: [31.6360, 74.8808] }
    ]
  },
  "Bus 202": {
    color: "#2ecc71",
    stops: [
      { name: "Ranjit Avenue", coords: [31.6510, 74.8545] },
      { name: "GNDU",          coords: [31.6415, 74.8255] },
      { name: "Lawrence Road", coords: [31.6410, 74.8690] },
      { name: "Bus Stand",     coords: [31.6360, 74.8808] }
    ]
  },
  "Bus 303": {
    color: "#3498db",
    stops: [
      { name: "Golden Temple", coords: [31.6200, 74.8765] },
      { name: "Hall Bazaar",   coords: [31.6270, 74.8750] },
      { name: "GNDU",          coords: [31.6415, 74.8255] },
      { name: "Ranjit Avenue", coords: [31.6510, 74.8545] }
    ]
  }
};

// tweak: how close (meters) we consider "arrived"
const ARRIVAL_THRESHOLD_M = 120;

// how often marker steps (ms)
const STEP_MS = 700; // 700ms per step (reasonable for demo)

/* ===========================
   Globals
   =========================== */

let map = null;
const activePolylines = {}; // busName -> polyline
const activeMarkers = {};   // busName -> marker
const activeTimelines = new Set(); // busName that already has timeline created
const activeAnimations = {}; // busName -> { timerId:..., seqIndex:... }

/* ===========================
   Utilities
   =========================== */

function safeId(name) {
  return String(name).replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
}

// Haversine distance (meters)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ===========================
   Timeline UI
   =========================== */

function createTimeline(busName, stops) {
  const idName = safeId(busName);
  if (activeTimelines.has(idName)) return; // already created

  const wrapper = document.getElementById("timeline-wrap");
  if (!wrapper) {
    console.warn("timeline-wrap element not found in DOM.");
    return;
  }

  const container = document.createElement("div");
  container.className = "route-timeline";
  container.id = `timeline-${idName}`;

  const title = document.createElement("div");
  title.className = "route-title";
  title.innerText = `${busName} — ${stops.length} stops`;
  container.appendChild(title);

  const row = document.createElement("div");
  row.className = "stops-row";

  stops.forEach((s, i) => {
    const pill = document.createElement("div");
    pill.className = "stop-pill";
    pill.id = `pill-${idName}-${i}`;
    pill.innerHTML = `<div class="stop-name">${s.name}</div><div class="eta">--</div>`;
    row.appendChild(pill);
  });

  container.appendChild(row);
  wrapper.appendChild(container);
  activeTimelines.add(idName);
}

/* ===========================
   OSRM routing per segment
   =========================== */

// For a sequence of stops (with coords), fetch OSRM for each segment and concat all coords.
// Returns Promise<coordsArray> where coordsArray = [[lat,lng], ...]
async function fetchRoadForStops(stops) {
  // If stops is small (1), return its coords
  if (!stops || stops.length === 0) return [];
  if (stops.length === 1) return [stops[0].coords];

  let fullCoords = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i].coords;
    const to = stops[i + 1].coords;
    const lonLatA = `${from[1]},${from[0]}`;
    const lonLatB = `${to[1]},${to[0]}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${lonLatA};${lonLatB}?overview=full&geometries=geojson`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM status ${res.status}`);
      const data = await res.json();
      if (data && data.routes && data.routes.length) {
        const seg = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]); // to [lat,lng]
        if (seg.length) {
          // avoid duplicate point where segments meet
          if (fullCoords.length && arraysEqual(fullCoords[fullCoords.length - 1], seg[0])) {
            fullCoords = fullCoords.concat(seg.slice(1));
          } else {
            fullCoords = fullCoords.concat(seg);
          }
        } else {
          // fallback to straight line if geometry empty
          if (!fullCoords.length) fullCoords.push(from);
          fullCoords.push(to);
        }
      } else {
        // fallback straight
        if (!fullCoords.length) fullCoords.push(from);
        fullCoords.push(to);
      }
    } catch (err) {
      console.warn("OSRM fetch failed for segment — falling back to straight:", err);
      if (!fullCoords.length) fullCoords.push(from);
      fullCoords.push(to);
    }
  }
  // If still empty (shouldn't), fill with stops coords
  if (!fullCoords.length) {
    stops.forEach(s => fullCoords.push(s.coords));
  }
  if (!fullCoords.length) {
  console.warn("❌ OSRM failed, using straight line fallback for:", stops.map(s=>s.name).join(" → "));
  stops.forEach(s => fullCoords.push(s.coords));
}

console.log("✅ fetchRoadForStops returning", fullCoords.length, "points for:", stops.map(s => s.name).join(" → "));
return fullCoords;

}

function arraysEqual(a,b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i=0;i<a.length;i++){
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ===========================
   Marker animation (smooth along coords)
   =========================== */

function animateAlongRoad(busName, coords, marker, stops) {
  // ensure coords is an array and marker exists
  if (!coords || !coords.length || !marker) return;

  const idName = safeId(busName);
  let idx = 0;

// Mark first stop as arrived immediately
let nextStopIndex = 1; 
if (stops.length > 0) {
  const firstPill = document.getElementById(`pill-${idName}-0`);
  if (firstPill) {
  firstPill.classList.add("active");
  const etaDiv = firstPill.querySelector(".eta");
  if (etaDiv) etaDiv.textContent = "Arrived";

  // Notification + vibrate + sound for first stop
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`${busName} has started at ${stops[0].name}`);
  }
  if ("vibrate" in navigator) {
    navigator.vibrate([200, 100, 200]);
  }
  if (notifySound) {
    notifySound.currentTime = 0;
    notifySound.play().catch(err => console.warn("Sound play failed:", err));
  }
}

}


  // clear previous if any
  if (activeAnimations[idName] && activeAnimations[idName].timerId) {
    clearTimeout(activeAnimations[idName].timerId);
  }

  function step() {
    if (idx >= coords.length) {
      // end reached; keep marker at last point
      // optionally loop: idx = 0; nextStopIndex = 0; step();
      return;
    }

    const p = coords[idx];
    marker.setLatLng(p);

    // update popup occasionally (less frequent)
    if (idx % 10 === 0) {
      marker.setPopupContent(`${busName} — moving`);
    }

    // proximity check for next stop
    if (nextStopIndex < stops.length) {
      const stop = stops[nextStopIndex];
      const d = distanceMeters(p[0], p[1], stop.coords[0], stop.coords[1]);
      const pill = document.getElementById(`pill-${idName}-${nextStopIndex}`);
      if (pill) {
        const etaDiv = pill.querySelector(".eta");
        if (d < ARRIVAL_THRESHOLD_M) {
  pill.classList.add("active");
  if (etaDiv) etaDiv.textContent = "Arrived";

  // 🔔 Safe notification (desktop works, mobile won't break loop)
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`${busName} has arrived at ${stop.name}`);
    }
  } catch (e) {
    console.warn("Notification blocked on mobile, continuing animation:", e);
  }

  // 📳 Vibrate (if supported)
  if ("vibrate" in navigator) {
    navigator.vibrate([200, 100, 200]);
  }

  // 🔊 Play sound (safe after user taps once on page)
  if (notifySound) {
    notifySound.currentTime = 0;
    notifySound.play().catch(err => console.warn("Sound play failed:", err));
  }

  nextStopIndex++;
}

else {
          if (etaDiv) {
            // crude ETA estimate based on remaining distance (demo only)
            const minutes = Math.max(1, Math.round(d / 200)); // 200 m per minute
            etaDiv.textContent = `${minutes} min`;
          }
        }
      }
    }

    idx++;
    activeAnimations[idName] = { timerId: setTimeout(step, STEP_MS) };
  }

  step();
}

/* ===========================
   Map and UI bootstrap
   =========================== */

function initMap() {
  map = L.map("map", { scrollWheelZoom: false }).setView([31.6340, 74.8723], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);

  // Add zoom control positioned (optional)
  L.control.zoom({ position: "topright" }).addTo(map);
}

function populateUI() {
  const fromSelect = document.getElementById("fromSelect");
  const toSelect = document.getElementById("toSelect");
  const routesList = document.getElementById("routesList");

  if (!fromSelect || !toSelect || !routesList) {
    console.warn("populateUI: necessary DOM elements not found");
    return;
  }

  // fill From/To with unique stops present across ROUTES
  const stopsSet = new Set();
  Object.values(ROUTES).forEach(r => r.stops.forEach(s => stopsSet.add(s.name)));

  // Clear existing
  fromSelect.innerHTML = "<option value=''>-- choose --</option>";
  toSelect.innerHTML = "<option value=''>-- choose --</option>";
  routesList.innerHTML = "";

  Array.from(stopsSet).sort().forEach(stopName => {
    const o1 = document.createElement("option");
    o1.value = stopName; o1.textContent = stopName;
    fromSelect.appendChild(o1);

    const o2 = document.createElement("option");
    o2.value = stopName; o2.textContent = stopName;
    toSelect.appendChild(o2);
  });

  // quick-route pills (click to autofill)
  Object.entries(ROUTES).forEach(([busName, r]) => {
    const li = document.createElement("li");
    li.className = "route-pill";
    li.textContent = `${busName} — ${r.stops.map(s => s.name).join(" → ")}`;
    li.onclick = () => {
      fromSelect.value = r.stops[0].name;
      toSelect.value = r.stops[r.stops.length - 1].name;
    };
    routesList.appendChild(li);
  });
}

// Clear previous visuals (polylines, markers, animations)
function clearActiveVisuals() {
  Object.values(activePolylines).forEach(p => {
    try { map.removeLayer(p); } catch(e){}
  });
  Object.values(activeMarkers).forEach(m => {
    try { map.removeLayer(m); } catch(e){}
  });
  // clear animation timers
  Object.values(activeAnimations).forEach(a => {
    if (a && a.timerId) clearTimeout(a.timerId);
  });

  // reset containers
  for (const k in activePolylines) delete activePolylines[k];
  for (const k in activeMarkers) delete activeMarkers[k];
  for (const k in activeAnimations) delete activeAnimations[k];

  // clear timeline DOM and set
  const wrapper = document.getElementById("timeline-wrap");
  if (wrapper) wrapper.innerHTML = "";
  activeTimelines.clear();
}

/* ===========================
   Main: handle Track button
   =========================== */

async function startTracking() {
  const from = document.getElementById("fromSelect").value;
  const to = document.getElementById("toSelect").value;

  if (!from || !to) {
    alert("Please select both From and To stops.");
    return;
  }

  // find matching routes with correct direction
  const matched = [];
  Object.entries(ROUTES).forEach(([busName, r]) => {
    const names = r.stops.map(s => s.name);
    const startIdx = names.indexOf(from);
    const endIdx = names.indexOf(to);
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
      // use subStops between startIdx and endIdx inclusive
      const subStops = r.stops.slice(startIdx, endIdx + 1);
      matched.push({ busName, color: r.color, subStops });
    }
  });

  if (!matched.length) {
    alert("No buses found for that route inside Amritsar (demo). Try different pair.");
    return;
  }

  // clear previous visuals
  clearActiveVisuals();

  // compute all coords to fit map
  const allCoords = [];
  for (const m of matched) m.subStops.forEach(s => allCoords.push(s.coords));
  if (allCoords.length) {
    try { map.fitBounds(allCoords, { padding: [60, 60] }); } catch (e) {}
  }

  // for each matched route: fetch road coords, draw polyline, create marker + timeline, animate
  for (const m of matched) {
    const busName = m.busName;
    try {
      // 1) create timeline first (ensures pills exist before animation)
      createTimeline(busName, m.subStops);

      // 2) fetch road-following coords (OSRM)
      const fullCoords = await fetchRoadForStops(m.subStops);

      // 3) draw polyline
      const polyline = L.polyline(fullCoords, { color: m.color, weight: 5, opacity: 0.9 }).addTo(map);
      activePolylines[safeId(busName)] = polyline;

      // 4) create single marker for this bus
      const icon = L.icon({ iconUrl: "bus.png", iconSize: [42, 42], iconAnchor: [21, 42], popupAnchor: [0, -40] });
      const marker = L.marker(fullCoords[0], { icon }).addTo(map);
      marker.bindTooltip(busName, { permanent: false, direction: "top" });
      marker.bindPopup(`${busName} — ${m.subStops[0].name}`);
      activeMarkers[safeId(busName)] = marker;

      // 5) animate marker along the fullCoords and sync timeline
      animateAlongRoad(busName, fullCoords, marker, m.subStops);
    } catch (err) {
      console.error("Failed setup for", m.busName, err);
    }
  }

  // bring timeline into view for demo
  const tw = document.getElementById("timeline-wrap");
  if (tw) tw.scrollIntoView({ behavior: "smooth" });
}

/* ===========================
   DOM ready bootstrap
   =========================== */

document.addEventListener("DOMContentLoaded", () => {
  // initialize UI and map
  initMap();
  populateUI();

  // wire the Track button
  const btn = document.getElementById("trackBtn");
  if (btn) btn.addEventListener("click", startTracking);
  else console.warn("#trackBtn not found");
});
document.addEventListener("DOMContentLoaded", () => {
  // existing initMap, populateUI, trackBtn code ...

  const enableBtn = document.getElementById("enableAlerts");
  if (enableBtn) {
    enableBtn.addEventListener("click", () => {
      if ("Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission();
      }
      if (notifySound) {
        notifySound.play().catch(()=>{});
      }
      alert("Alerts enabled ✅ Now you will get notifications, sound & vibration.");
    });
  }
});


/* ===========================
   Helpful debug export (optional)
   =========================== */
window._trackMyBusDebug = {
  ROUTES,
  activePolylines,
  activeMarkers,
  activeAnimations
};
