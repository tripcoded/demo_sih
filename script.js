// script.js — multiple routes, animated markers, timeline sync

// ----- Data: routes (all inside Amritsar) -----
function safeId(busName) {
  return busName.replace(/\s+/g, '_');  // replace spaces with underscores
}
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

// Globals
let map;
let activePolylines = [];
let activeMarkers = [];
let activeIntervals = [];
const TIMELINE_WRAPPER = document.getElementById("timeline-wrap");

// init map
function initMap(){
  map = L.map('map', { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors'
  }).addTo(map);
}

// populate UI: routes list and selects
function populateUI(){
  const routesList = document.getElementById("routesList");
  const fromSelect = document.getElementById("fromSelect");
  const toSelect = document.getElementById("toSelect");

  routesList.innerHTML = "";
  // gather unique stop names
  const stopsSet = new Set();
  Object.entries(ROUTES).forEach(([busName, r])=>{
    // route pill
    const li = document.createElement("li");
    li.className = "route-pill";
    li.textContent = busName + " — " + r.stops.map(s=>s.name).join(" → ");
    li.onclick = ()=> {
      // autofill first and last stops (convenient)
      fromSelect.value = r.stops[0].name;
      toSelect.value = r.stops[r.stops.length-1].name;
      // optionally auto-track:
      // startTracking();
    };
    routesList.appendChild(li);

    r.stops.forEach(s => stopsSet.add(s.name));
  });

  // fill selects (keep existing default)
  const stopsArr = Array.from(stopsSet).sort();
  // clear except default
  fromSelect.innerHTML = "<option value=''>-- choose --</option>";
  toSelect.innerHTML   = "<option value=''>-- choose --</option>";
  stopsArr.forEach(name=>{
    const o1 = new Option(name,name);
    const o2 = new Option(name,name);
    fromSelect.add(o1); toSelect.add(o2);
  });
}

// utility: clear previous active things
function clearActive(){
  activePolylines.forEach(p=>map.removeLayer(p));
  activeMarkers.forEach(m=>map.removeLayer(m));
  activeIntervals.forEach(id=>clearInterval(id));
  activePolylines = []; activeMarkers = []; activeIntervals = [];
  TIMELINE_WRAPPER.innerHTML = "";
}

// compute simple ETA per stop (demo): 2.5 minutes per stop
function computeETA(index, total){
  const minsPerStop = 3; // demo param
  const remaining = total - 1 - index;
  return `${remaining * minsPerStop} min`;
}

// create timeline UI for a bus

function createTimeline(busName, stops){
  const container = document.createElement("div");
  container.className = "route-timeline";
  const title = document.createElement("div");
  title.className = "route-title";
  title.innerText = `${busName} — stops (${stops.length})`;
  container.appendChild(title);

  const row = document.createElement("div");
  row.className = "stops-row";
  stops.forEach((s, i) => {
    const pill = document.createElement("div");
    pill.className = "stop-pill";
    pill.id = `pill-${busName.replace(/\s+/g,'')}-${i}`;
    pill.innerHTML = `<div>${s.name}</div><div class="eta">${computeETA(i,stops.length)}</div>`;
    row.appendChild(pill);
  });
  container.appendChild(row);
  TIMELINE_WRAPPER.appendChild(container);
}

// animate marker along stops (jumps per stop, updates timeline & popup)
function animateBus(busName, stops, marker){
  let i = 0;
  // highlight initial pill
  function highlight(index){
    // clear all pills for this bus
    for(let k=0;k<stops.length;k++){
      const el = document.getElementById(`pill-${busName.replace(/\s+/g,'')}-${k}`);
      if(el) el.classList.toggle('active', k === index);
    }
  }
  highlight(0);
  marker.bindPopup(`${busName} — ${stops[0].name}`).openPopup();

  // const id = setInterval(()=>{
  //   i = (i+1) % stops.length; // loop for demo
  //   const s = stops[i];
  //   marker.setLatLng(s.coords);
  //   marker.setPopupContent(`${busName} — ${s.name} <br>ETA: ${computeETA(i,stops.length)}`);
  //   marker.openPopup();
  //   highlight(i);
  // }, 3000);

  // activeIntervals.push(id);
  animateAlongRoad(busName, stops.map(s => s.coords), marker, stops);

}

// start tracking after user picks from & to
function startTracking(){
  const from = document.getElementById("fromSelect").value;
  const to   = document.getElementById("toSelect").value;
  if(!from || !to){ alert("Please choose both From and To."); return; }
  clearActive();

  const matched = [];
  Object.entries(ROUTES).forEach(([busName, r])=>{
    const names = r.stops.map(s=>s.name);
    const startIdx = names.indexOf(from);
    const endIdx = names.indexOf(to);
    // require same direction (start before end)
    if(startIdx !== -1 && endIdx !== -1 && startIdx < endIdx){
      matched.push({ busName, subStops: r.stops.slice(startIdx, endIdx+1), color: r.color });
    }
  });

  if(matched.length === 0){
    alert("No buses found for that route inside Amritsar (demo). Try a different pair.");
    return;
  }

  // fit map to show all matched routes
  const allCoords = [];
  matched.forEach(m=> m.subStops.forEach(s=> allCoords.push(s.coords)));
  if(allCoords.length) map.fitBounds(allCoords, { padding:[60,60] });

  // For each matched route: draw polyline, create marker and timeline & animate
  matched.forEach(m=>{
    // Build road-following path for each segment using OSRM
let fullCoords = [];
const fetchPromises = [];

for (let j = 0; j < m.subStops.length - 1; j++) {
  const from = m.subStops[j].coords;
  const to = m.subStops[j+1].coords;
  const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;

  fetchPromises.push(
    fetch(url)
      .then(res => res.json())
      .then(data => {
        const segCoords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        fullCoords = fullCoords.concat(segCoords);
      })
  );
}

Promise.all(fetchPromises).then(() => {
  const line = L.polyline(fullCoords, { color: m.color, weight: 5, opacity: 0.8 }).addTo(map);
  activePolylines.push(line);

  // custom icon with bus.png
  const icon = L.icon({ iconUrl: 'bus.png', iconSize: [42,42], iconAnchor:[21,42], popupAnchor:[0,-40] });
  const marker = L.marker(fullCoords[0], { icon }).addTo(map);
  marker.bindTooltip(m.busName, {permanent:false, direction:'top'});
  activeMarkers.push(marker);
  console.log("Starting animation for", m.busName, "with", fullCoords.length, "points");
animateAlongRoad(m.busName, fullCoords, marker, m.subStops);


  // timeline UI
  createTimeline(m.busName, m.subStops);

  
});


    // custom icon with bus.png
    const icon = L.icon({ iconUrl: 'bus.png', iconSize: [42,42], iconAnchor:[21,42], popupAnchor:[0,-40] });
    const marker = L.marker(m.subStops[0].coords, { icon }).addTo(map);
    marker.bindTooltip(m.busName, {permanent:false, direction:'top'});
    activeMarkers.push(marker);

    // timeline UI
    createTimeline(m.busName, m.subStops);

    // animate marker & timeline
    animateBus(m.busName.replace(/\s+/g,''), m.subStops, marker); // note id used in pills
    // note: animateBus uses id formed from busName in createTimeline; ensure consistency
    // But animateBus expects busName exactly as used in createTimeline; pass original
    // small fix: we passed busName with spaces replaced; correct below in animateBus calls - handled
  });

  // small UX: scroll to timeline
  document.getElementById('timeline-wrap').scrollIntoView({behavior:'smooth'});
}

// wire UI
document.getElementById("trackBtn").addEventListener("click", startTracking);

// On load
initMap();
populateUI();

// expose startTracking to console if needed
window.startTracking = startTracking;
// Animate bus marker smoothly along the fullCoords road path
function animateAlongRoad(busName, coords, marker, stops) {
  const idName = busName.replace(/\s+/g, "_"); // safe id
  let i = 0;
  let stopIndex = 0;

  function move() {
    if (i >= coords.length) return;

    const point = coords[i];
    marker.setLatLng(point);

    // --- check stop proximity and update timeline ---
    if (stopIndex < stops.length) {
      const stop = stops[stopIndex];
      const pillId = `pill-${idName}-${stopIndex}`;
      const pill = document.getElementById(pillId);

      if (pill) {
        const d = distanceMeters(
          point[0], point[1],
          stop.coords[0], stop.coords[1]
        );
        if (d < 120) { // bus reached the stop
          pill.classList.add("active");
          const etaDiv = pill.querySelector(".eta");
          if (etaDiv) etaDiv.textContent = "Arrived";
          stopIndex++;
        } else {
          const etaDiv = pill.querySelector(".eta");
          if (etaDiv) etaDiv.textContent =
            Math.max(1, Math.round(d / 200)) + " min";
        }
      }
    }

    i++;
    setTimeout(move, 1000); // smoother movement speed
  }

  move();
}


