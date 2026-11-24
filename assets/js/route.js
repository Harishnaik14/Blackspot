const startInput = document.getElementById('startLocation');
const destinationInput = document.getElementById('destination');
const startSuggestions = document.getElementById('startSuggestions');
const destinationSuggestions = document.getElementById('destinationSuggestions');
let startPlace = null;
let destinationPlace = null;
let routeMarkers = [];

function saveRouteSelection() {
  if (!startPlace || !destinationPlace) return;
  localStorage.setItem('blackspotRouteSelection', JSON.stringify({
    start: startPlace,
    destination: destinationPlace,
  }));
}

function restoreRouteSelection() {
  try {
    const saved=JSON.parse(localStorage.getItem('blackspotRouteSelection')||'null');
    if(saved?.start?.name && saved?.destination?.name){
      startPlace=saved.start;
      destinationPlace=saved.destination;
      startInput.value=saved.start.name;
      destinationInput.value=saved.destination.name;
      return true;
    }
  } catch (_) {}
  return false;
}

const routeMap = new maplibregl.Map({
  container: 'routeMap',
  style: {
    version: 8,
    sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  center: [75.427,13.058],
  zoom: 9.2,
});
routeMap.addControl(new maplibregl.NavigationControl(), 'bottom-right');

let suggestionTimers = {};
async function searchPlaces(query) {
  if (query.trim().length < 3) return [];
  const data = await window.BlackspotAPI.get(`/api/geocode/?q=${encodeURIComponent(query)}`);
  return data.results || [];
}

function renderSuggestions(container, places, input, assignPlace) {
  container.replaceChildren();
  if (!places.length) {
    container.hidden = true;
    return;
  }
  places.forEach((place) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion';
    button.textContent = place.name;
    button.addEventListener('click', () => {
      input.value = place.name;
      assignPlace(place);
      container.hidden = true;
      saveRouteSelection();
    });
    container.appendChild(button);
  });
  container.hidden = false;
}

function bindAutocomplete(input, container, assignPlace) {
  input.addEventListener('input', () => {
    assignPlace(null);
    clearTimeout(suggestionTimers[input.id]);
    const value = input.value;
    suggestionTimers[input.id] = setTimeout(async () => {
      try {
        const places = await searchPlaces(value);
        renderSuggestions(container, places, input, assignPlace);
      } catch (error) {
        container.hidden = true;
      }
    }, 350);
  });
  input.addEventListener('blur', () => setTimeout(() => { container.hidden = true; }, 150));
  input.addEventListener('focus', () => {
    if (container.childElementCount) container.hidden = false;
  });
}

bindAutocomplete(startInput, startSuggestions, (place) => { startPlace = place; });
bindAutocomplete(destinationInput, destinationSuggestions, (place) => { destinationPlace = place; });

async function resolveDefaultPlaces() {
  if (restoreRouteSelection()) return;
  try {
    const [starts,destinations]=await Promise.all([
      searchPlaces(startInput.value),
      searchPlaces(destinationInput.value),
    ]);
    if(starts[0]){startPlace=starts[0];startInput.value=starts[0].name;}
    if(destinations[0]){destinationPlace=destinations[0];destinationInput.value=destinations[0].name;}
    saveRouteSelection();
  } catch (_) {}
}
resolveDefaultPlaces();

async function loadRoutePreview() {
  if (!startPlace || !destinationPlace) return;
  const params = new URLSearchParams({
    start_lat: startPlace.lat,
    start_lon: startPlace.lon,
    end_lat: destinationPlace.lat,
    end_lon: destinationPlace.lon,
  });
  const data = await window.BlackspotAPI.get(`/api/routes/?${params}`);
  const selectedRoute = data.routes.find((route) => route.id === 'charmadi-ghat');
  if (!selectedRoute?.coordinates?.length) throw new Error('OSRM did not return route geometry.');

  const coordinates = selectedRoute.coordinates.map((point) => [point.lon, point.lat]);
  const geojson = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
  if (routeMap.getSource('selected-route')) {
    routeMap.getSource('selected-route').setData(geojson);
  } else {
    routeMap.addSource('selected-route', { type: 'geojson', data: geojson });
    routeMap.addLayer({ id: 'selected-route-glow', type: 'line', source: 'selected-route', paint: { 'line-color': '#70d8d1', 'line-width': 11, 'line-opacity': 0.15 } });
    routeMap.addLayer({ id: 'selected-route', type: 'line', source: 'selected-route', paint: { 'line-color': '#70d8d1', 'line-width': 5 } });
  }

  document.querySelectorAll('.selected-route-marker').forEach((marker) => marker.remove());
  routeMarkers.forEach((marker) => marker.remove());
  routeMarkers = [];
  const startMarker = document.createElement('div');
  startMarker.className = 'selected-route-marker';
  startMarker.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#55d6a0;border:2px solid white';
  routeMarkers.push(new maplibregl.Marker({ element: startMarker }).setLngLat(coordinates[0]).addTo(routeMap));
  const endMarker = document.createElement('div');
  endMarker.className = 'selected-route-marker';
  endMarker.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#ff6b6b;border:2px solid white';
  routeMarkers.push(new maplibregl.Marker({ element: endMarker }).setLngLat(coordinates[coordinates.length - 1]).addTo(routeMap));

  const longitudes = coordinates.map((point) => point[0]);
  const latitudes = coordinates.map((point) => point[1]);
  routeMap.fitBounds([
    [Math.min(...longitudes), Math.min(...latitudes)],
    [Math.max(...longitudes), Math.max(...latitudes)],
  ], { padding: 45, duration: 900 });
  try {
    const indiaCurves=await window.BlackspotAPI.get('/api/dataset/curves/');
    const seen=new Set();
    indiaCurves.filter((curve)=>{
      const lat=Number(curve.latitude),lon=Number(curve.longitude),radius=Number(curve.radius_m);
      const severity=String(curve.severity||'').toLowerCase();
      const curveType=String(curve.curve_type||'').toLowerCase();
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return false;
      if(severity!=='sharp'&&severity!=='hairpin'&&curveType!=='hairpin'&&radius>=80)return false;
      return coordinates.some((point)=>{
        const latDelta=(point[1]-lat)*111000;
        const lonDelta=(point[0]-lon)*111000*Math.cos(lat*Math.PI/180);
        return Math.sqrt(latDelta*latDelta+lonDelta*lonDelta)<=500;
      });
    }).forEach((curve)=>{
      const lat=Number(curve.latitude),lon=Number(curve.longitude);
      const key=`${lat.toFixed(5)},${lon.toFixed(5)}`;
      if(seen.has(key))return;
      seen.add(key);
      const markerElement=document.createElement('div');
      markerElement.style.cssText='width:34px;height:34px;border-radius:50%;display:grid;place-items:center;border:3px solid #07111d;background:#ff6b6b;color:white;font-size:12px;font-weight:900;box-shadow:0 0 0 3px rgba(255,107,107,.28),0 8px 18px rgba(0,0,0,.35)';
      markerElement.textContent='S';
      markerElement.title='Sharp bend';
      routeMarkers.push(new maplibregl.Marker({element:markerElement})
        .setLngLat([lon,lat])
        .setPopup(new maplibregl.Popup({offset:12}).setHTML(`<strong>Sharp bend</strong><br>Direction: ${curve.curve_direction||'unknown'}<br>Radius: ${curve.radius_m} m<br>Source: ${curve.data_source||'India curve dataset'}<br>Verification: ${curve.verification_status||'unverified'}`))
        .addTo(routeMap));
    });
  } catch (_) {}
  return selectedRoute;
}

document.getElementById('findRoute').addEventListener('click', async () => {
  const results = document.getElementById('routeResults');
  if (!startPlace || !destinationPlace) {
    results.innerHTML = '<p style="color:var(--muted)">Resolving the selected places…</p>';
    await resolveDefaultPlaces();
    if (!startPlace || !destinationPlace) {
      results.innerHTML = '<p style="color:var(--yellow)">Select a starting place and destination from the search suggestions.</p>';
      return;
    }
  }
  results.innerHTML = '<p style="color:var(--muted)">Calculating a road-following route…</p>';
  try {
    saveRouteSelection();
    const selectedRoute = await loadRoutePreview();
    const distanceKm = selectedRoute.distance_m ? (selectedRoute.distance_m / 1000).toFixed(1) : 'Unknown';
    results.innerHTML = `
      <article class="card" style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;gap:12px">
          <div><strong>${selectedRoute.name}</strong><p style="font-size:12px;color:var(--muted)">OSRM road geometry · ${distanceKm} km</p></div>
          <button class="button button-primary start-route" data-start-lat="${startPlace.lat}" data-start-lon="${startPlace.lon}" data-end-lat="${destinationPlace.lat}" data-end-lon="${destinationPlace.lon}">Start</button>
        </div>
      </article>`;
  } catch (error) {
    results.innerHTML = `<p style="color:var(--yellow)">Could not calculate route: ${error.message}</p>`;
  }
});

document.getElementById('routeResults').addEventListener('click', (event) => {
  if (!event.target.classList.contains('start-route')) return;
  const params = new URLSearchParams({
    startLat: event.target.dataset.startLat,
    startLon: event.target.dataset.startLon,
    endLat: event.target.dataset.endLat,
    endLon: event.target.dataset.endLon,
    startName: startPlace.name,
    endName: destinationPlace.name,
  });
  location.href = `driving.html?${params}`;
});
