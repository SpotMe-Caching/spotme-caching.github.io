'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// nav.js — gemeinsame Navigations-Overlay-Logik
// ═══════════════════════════════════════════════════════════════════════════
// Wird von index.html, live-spot.html und waypoints.html gleichermaßen genutzt.
// Externe Abhängigkeiten, die die einbindende Seite bereitstellen muss:
//   - maplibregl       (CDN-Script, vor diesem hier eingebunden)
//   - userPos          (globale Variable: { lat, lng } | null)
//   - HTML-Markup mit den IDs: naviOverlay, naviMap, naviSpotName,
//     naviDistVal, naviFootVal, naviCarVal, naviRecenterBtn
//
// Routing: Fußweg über OpenRouteService (falls ORS_KEY gesetzt) oder OSRM-Fallback.
// Fahrrad über OSRM (öffentlicher Demo-Server, Profile car/foot/bike).
// ═══════════════════════════════════════════════════════════════════════════

const ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjI5NmQwYWMxYmM0MzQxNjdiOTE2Mjk2ZjFiOTk3MmRjIiwiaCI6Im11cm11cjY0In0=';

let naviMap          = null;
let naviUserMarker   = null;
let naviSpotMarker   = null;
let naviWatchId      = null;
let naviLastRoutePos = null;
let naviRouting      = false;
let naviTarget       = null;
let naviCentered     = true;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Wrapper für Aufrufe aus index.html (Drawer, Favoriten, Radius, Live Spots etc.)
function navigateToSpot(lat, lng, name) {
  navigate(lat, lng, name);
}

// Einstiegspunkt mit frischer GPS-Abfrage davor (für Seiten ohne laufendes watchPosition)
function navigate(lat, lng, name) {
  navigator.geolocation?.getCurrentPosition(pos => {
    userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    openNavOverlay(lat, lng, name);
  }, () => openNavOverlay(lat, lng, name), { enableHighAccuracy: true });
}

function openNavOverlay(lat, lng, name) {
  naviTarget = { lat, lng, name: name || 'Spot' };
  naviLastRoutePos = null;
  naviRouting = false;
  naviCentered = true;

  document.getElementById('naviSpotName').textContent = naviTarget.name;
  const sub = document.getElementById('naviSpotSub');
  if (sub) sub.textContent = 'NAVIGATION · GPS aktiv';
  document.getElementById('naviDistVal').textContent = '…';
  document.getElementById('naviFootVal').textContent = '…';
  document.getElementById('naviCarVal').textContent = '…';
  document.getElementById('naviOverlay').classList.add('active');

  const recenterBtn = document.getElementById('naviRecenterBtn');
  if (recenterBtn) {
    recenterBtn.onclick = () => {
      naviCentered = true;
      if (naviMap && userPos) {
        naviMap.flyTo({ center: [userPos.lng, userPos.lat], zoom: 15, duration: 600 });
      }
    };
  }

  setTimeout(() => {
    if (naviMap) { naviMap.remove(); naviMap = null; }
    naviUserMarker = null;
    naviSpotMarker = null;

    const center = userPos
      ? [(userPos.lng + lng) / 2, (userPos.lat + lat) / 2]
      : [lng, lat];

    naviMap = new maplibregl.Map({
      container: 'naviMap',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center, zoom: 14,
      attributionControl: false
    });

    naviMap.on('dragstart', () => { naviCentered = false; });

    naviMap.on('load', () => {
      const sEl = document.createElement('div');
      sEl.style.cssText = 'width:22px;height:22px;background:#ff9f00;border-radius:50%;border:2.5px solid rgba(255,255,255,0.85);box-shadow:0 0 0 4px rgba(255,159,0,0.2),0 0 20px rgba(255,159,0,0.8);';
      naviSpotMarker = new maplibregl.Marker({ element: sEl }).setLngLat([lng, lat]).addTo(naviMap);

      if (userPos) {
        naviAddUserMarker();
        naviUpdateDistDisplay();
        naviFitBounds();
        naviFetchRoute();
      }
    });

    if (navigator.geolocation) {
      naviWatchId = navigator.geolocation.watchPosition(pos => {
        userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };

        if (naviUserMarker) naviUserMarker.setLngLat([userPos.lng, userPos.lat]);
        else naviAddUserMarker();

        if (naviCentered && naviMap) {
          naviMap.easeTo({ center: [userPos.lng, userPos.lat], duration: 400 });
        }

        naviUpdateDistDisplay();

        const moved = naviLastRoutePos
          ? haversineKm(naviLastRoutePos.lat, naviLastRoutePos.lng, userPos.lat, userPos.lng) * 1000
          : 999;
        if (moved > 25) naviFetchRoute();
      }, null, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    }
  }, 80);
}

function naviAddUserMarker() {
  if (!naviMap || !userPos) return;
  if (naviUserMarker) naviUserMarker.remove();
  const uEl = document.createElement('div');
  uEl.style.cssText = 'width:18px;height:18px;background:#22d3ee;border-radius:50%;border:3px solid white;box-shadow:0 0 10px rgba(34,211,238,0.9);';
  naviUserMarker = new maplibregl.Marker({ element: uEl }).setLngLat([userPos.lng, userPos.lat]).addTo(naviMap);
}

function naviFitBounds() {
  if (!naviMap || !userPos || !naviTarget) return;
  const bounds = new maplibregl.LngLatBounds([userPos.lng, userPos.lat], [naviTarget.lng, naviTarget.lat]);
  naviMap.fitBounds(bounds, { padding: 80, maxZoom: 16 });
}

function naviUpdateDistDisplay() {
  if (!userPos || !naviTarget) return;
  const m = haversineKm(userPos.lat, userPos.lng, naviTarget.lat, naviTarget.lng) * 1000;
  document.getElementById('naviDistVal').textContent = m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function naviClearRouteLayers() {
  if (!naviMap) return;
  ['navi-foot-casing', 'navi-foot', 'navi-car-casing', 'navi-car'].forEach(id => {
    if (naviMap.getLayer(id)) naviMap.removeLayer(id);
  });
  ['navi-src-foot', 'navi-src-car'].forEach(id => {
    if (naviMap.getSource(id)) naviMap.removeSource(id);
  });
}

async function naviFetchRoute() {
  if (!userPos || !naviTarget || !naviMap || naviRouting) return;
  naviRouting = true;
  naviLastRoutePos = { ...userPos };

  const start = `${userPos.lng},${userPos.lat}`;
  const end   = `${naviTarget.lng},${naviTarget.lat}`;
  const osrmBase = `${userPos.lng},${userPos.lat};${naviTarget.lng},${naviTarget.lat}?overview=full&geometries=geojson`;

  // Fahrrad – öffentlicher OSRM-Demo-Server, Profil "bike"
  const bikePromise = fetch(`https://router.project-osrm.org/route/v1/bike/${osrmBase}`)
    .then(r => r.json()).catch(() => null);

  // Fußweg – ORS wenn Key gesetzt, sonst OSRM-Fallback
  const footPromise = ORS_KEY
    ? fetch(`https://api.openrouteservice.org/v2/directions/foot-hiking?api_key=${ORS_KEY}&start=${start}&end=${end}`)
        .then(r => r.json()).catch(() => null)
    : fetch(`https://router.project-osrm.org/route/v1/foot/${osrmBase}`)
        .then(r => r.json()).catch(() => null);

  const [bikeData, footRaw] = await Promise.all([bikePromise, footPromise]);

  naviRouting = false;
  if (!naviMap) return; // Overlay wurde inzwischen geschlossen

  naviClearRouteLayers();

  const fmtMin = s => {
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  if (bikeData?.routes?.length) {
    const r = bikeData.routes[0];
    naviMap.addSource('navi-src-car', { type: 'geojson', data: { type: 'Feature', geometry: r.geometry } });
    naviMap.addLayer({ id: 'navi-car-casing', type: 'line', source: 'navi-src-car', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0a0d12', 'line-width': 8, 'line-opacity': 0.7 } });
    naviMap.addLayer({ id: 'navi-car', type: 'line', source: 'navi-src-car', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f59e0b', 'line-width': 5, 'line-opacity': 0.9 } });
    document.getElementById('naviCarVal').textContent = fmtMin(r.duration);
  }

  let footGeometry = null, footDuration = null;
  if (ORS_KEY && footRaw?.features?.length) {
    footGeometry = footRaw.features[0].geometry;
    footDuration = footRaw.features[0].properties?.summary?.duration;
  } else if (!ORS_KEY && footRaw?.routes?.length) {
    footGeometry = footRaw.routes[0].geometry;
    footDuration = footRaw.routes[0].duration;
  }

  if (footGeometry) {
    naviMap.addSource('navi-src-foot', { type: 'geojson', data: { type: 'Feature', geometry: footGeometry } });
    naviMap.addLayer({ id: 'navi-foot-casing', type: 'line', source: 'navi-src-foot', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0a0d12', 'line-width': 6, 'line-opacity': 0.6 } });
    naviMap.addLayer({ id: 'navi-foot', type: 'line', source: 'navi-src-foot', layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#22d3ee', 'line-width': 3, 'line-opacity': 1, 'line-dasharray': [2, 2] } });
    if (footDuration) document.getElementById('naviFootVal').textContent = fmtMin(footDuration);
  }
}

function closeNavOverlay() {
  if (naviWatchId) { navigator.geolocation.clearWatch(naviWatchId); naviWatchId = null; }
  if (naviMap) { naviMap.remove(); naviMap = null; }
  naviUserMarker = null;
  naviSpotMarker = null;
  naviLastRoutePos = null;
  naviTarget = null;
  naviRouting = false;
  document.getElementById('naviOverlay').classList.remove('active');
}

document.addEventListener('keydown', e => {
  const overlay = document.getElementById('naviOverlay');
  if (e.key === 'Escape' && overlay?.classList.contains('active')) {
    closeNavOverlay();
  }
});
