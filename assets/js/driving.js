import * as THREE from 'https://esm.sh/three@0.169.0';
import { brakingAlertDistance, isHighRiskBend, shouldAlert } from './hazard-engine.mjs';

let route = [];
let curves = [];
let blackspots = [];
let hasImportedGpsRoute = false;
let sharpBendMarkers = [];
let routeEndpointMarkers = [];

function renderRouteEndpointMarkers(startPoint, endPoint) {
  routeEndpointMarkers.forEach((marker)=>marker.remove());
  routeEndpointMarkers=[];
  if(!startPoint || !endPoint)return;
  const startElement=document.createElement('div');
  startElement.style.cssText='width:16px;height:16px;border-radius:50%;background:#55d6a0;border:3px solid white;box-shadow:0 0 0 5px rgba(85,214,160,.20)';
  startElement.title='Route start';
  const endElement=document.createElement('div');
  endElement.style.cssText='width:16px;height:16px;border-radius:50%;background:#ff6b6b;border:3px solid white;box-shadow:0 0 0 5px rgba(255,107,107,.20)';
  endElement.title='Destination';
  routeEndpointMarkers.push(new maplibregl.Marker({element:startElement}).setLngLat(startPoint).addTo(map));
  routeEndpointMarkers.push(new maplibregl.Marker({element:endElement}).setLngLat(endPoint).addTo(map));
}

function isSharpBend(curve) {
  const severity=String(curve.severity||'').toLowerCase();
  const curveType=String(curve.curveType||curve.curve_type||'').toLowerCase();
  return severity==='sharp'||severity==='hairpin'||curveType==='hairpin'||Number(curve.radius)<80;
}

function renderSharpBendMarkers() {
  sharpBendMarkers.forEach((marker)=>marker.remove());
  sharpBendMarkers=[];
  curves.filter(isSharpBend).forEach((curve,index)=>{
    if(pointToRouteDistanceMeters(curve.lat,curve.lng)>500)return;
    const element=document.createElement('div');
    element.style.cssText='width:34px;height:34px;border-radius:50%;display:grid;place-items:center;border:3px solid #07111d;background:#ff6b6b;color:white;font-size:12px;font-weight:900;box-shadow:0 0 0 3px rgba(255,107,107,.28),0 8px 18px rgba(0,0,0,.35)';
    element.textContent='S';
    element.title=`Sharp bend ${index+1}`;
    sharpBendMarkers.push(new maplibregl.Marker({element})
      .setLngLat([curve.lng,curve.lat])
      .setPopup(new maplibregl.Popup({offset:12}).setHTML(`<strong>Sharp bend ${index+1}</strong><br>Direction: ${curve.direction||'unknown'}<br>Radius: ${Math.round(curve.radius)} ± ${curve.uncertainty||0} m<br>Source: ${curve.source||'Uploaded curve database'}<br>Verification: ${curve.verificationStatus||'unverified'}`))
      .addTo(map));
  });
}

function pointToRouteDistanceMeters(lat, lon) {
  if (!route.length) return Infinity;
  let closest = Infinity;
  for (let index = 0; index < route.length - 1; index += 1) {
    const a = [route[index][0], route[index][1]];
    const b = [route[index + 1][0], route[index + 1][1]];
    const latScale = 111000;
    const lonScale = 111000 * Math.cos(lat * Math.PI / 180);
    const ax = (a[0] - lon) * lonScale;
    const ay = (a[1] - lat) * latScale;
    const bx = (b[0] - lon) * lonScale;
    const by = (b[1] - lat) * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    closest = Math.min(closest, Math.sqrt(px * px + py * py));
  }
  return closest;
}

function hasCurveOnImportedRoute(point) {
  return hasImportedGpsRoute && pointToRouteDistanceMeters(point.lat, point.lng) <= 500;
}

function loadImportedBends() {
  try {
    const uploadedCurves = JSON.parse(localStorage.getItem('blackspotGhatCurves') || '[]');
    const uploadedBlackspots = JSON.parse(localStorage.getItem('blackspotAccidentBlackspots') || '[]');
    curves = uploadedCurves.filter(isSharpBend).map((curve) => {
      const radius = Number(curve.radius);
      const uncertainty = Math.round(Math.max(radius * .08, 2));
      const confidence = Number(curve.confidence) >= .85 ? 'High' : Number(curve.confidence) >= .65 ? 'Medium' : 'Low';
      return {
        lng: curve.lon,
        lat: curve.lat,
        radius,
        uncertainty,
        confidence,
        direction: curve.direction || 'unknown',
        severity: curve.severity || 'moderate',
        curveType: curve.curveType || 'curve',
        source: curve.source,
        verificationStatus: curve.verificationStatus,
        recommended: Math.round(Math.sqrt(.65 * 9.81 * radius) * 3.6),
      };
    });
    blackspots = uploadedBlackspots.map((spot) => ({
      lng: spot.lon,
      lat: spot.lat,
      count: spot.accidentCount,
      fatalities: spot.fatalities,
      source: spot.source,
      verificationStatus: spot.verificationStatus,
      risk: spot.accidentCount >= 10 ? 'Critical' : spot.accidentCount >= 5 ? 'High' : 'Medium',
    }));
  } catch (_) {
    curves = [];
  }
}
loadImportedBends();

const map = new maplibregl.Map({
  container:'map',
  style:{version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors'}},layers:[{id:'osm',type:'raster',source:'osm'}]},
  center:[75.445,13.060],
  zoom:11.3,
  pitch:52,
  bearing:-22,
  maxPitch:70,
});
map.addControl(new maplibregl.NavigationControl({visualizePitch:true}), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({
  positionOptions:{enableHighAccuracy:true},
  trackUserLocation:true,
  showUserHeading:true,
  showAccuracyCircle:true,
}), 'top-right');

function elementForMarker(color, label) {
  const el=document.createElement('div');
  el.style.cssText=`width:30px;height:30px;border-radius:50%;display:grid;place-items:center;border:2px solid white;background:${color};box-shadow:0 8px 24px ${color};font-size:11px;color:white;font-weight:800`;
  el.textContent=label;
  return el;
}

map.on('load', async () => {
  if (hasImportedGpsRoute) {
    const longitudeValues = route.map((point) => point[0]);
    const latitudeValues = route.map((point) => point[1]);
    if (longitudeValues.length && latitudeValues.length) {
      map.fitBounds([
        [Math.min(...longitudeValues), Math.min(...latitudeValues)],
        [Math.max(...longitudeValues), Math.max(...latitudeValues)],
      ], { padding: 55, duration: 900 });
    }
  }
  const query = new URLSearchParams(location.search);
  if (query.has('startLat') && query.has('endLat')) {
    document.getElementById('routeStartInput').value=query.get('startName')||'Selected start';
    document.getElementById('routeEndInput').value=query.get('endName')||'Selected destination';
    await showSelectedRoute();
  } else {
    try {
      const saved=JSON.parse(localStorage.getItem('blackspotLiveRouteSelection')||'null');
      if(saved?.start?.name && saved?.end?.name){
        document.getElementById('routeStartInput').value=saved.start.name;
        document.getElementById('routeEndInput').value=saved.end.name;
      } else {
        const routeSaved=JSON.parse(localStorage.getItem('blackspotRouteSelection')||'null');
        if(routeSaved?.start?.name && routeSaved?.destination?.name){
          document.getElementById('routeStartInput').value=routeSaved.start.name;
          document.getElementById('routeEndInput').value=routeSaved.destination.name;
        }
      }
    } catch (_) {}
  }
  if (route.length) {
    const routeGeojson={type:'Feature',properties:{},geometry:{type:'LineString',coordinates:route}};
    if(!map.getSource('route')){
      map.addSource('route',{type:'geojson',data:routeGeojson});
      map.addLayer({id:'route-glow',type:'line',source:'route',paint:{'line-color':'#70d8d1','line-width':10,'line-opacity':.12}});
      map.addLayer({id:'route-line',type:'line',source:'route',paint:{'line-color':'#70d8d1','line-width':4}});
    }else{
      map.getSource('route').setData(routeGeojson);
    }
  }
  if (route.length && !curves.length) {
    try {
      const indiaCurves = await window.BlackspotAPI.get('/api/dataset/curves/');
      const deduplicated = new Map();
      indiaCurves.forEach((curve) => {
        const point = { lat: Number(curve.latitude), lng: Number(curve.longitude), radius: Number(curve.radius_m), latSource: Number(curve.latitude), lonSource: Number(curve.longitude) };
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
        const severity=String(curve.severity||'').toLowerCase();
        const curveType=String(curve.curve_type||'').toLowerCase();
        if(severity!=='sharp' && severity!=='hairpin' && curveType!=='hairpin' && point.radius>=80)return;
        if (pointToRouteDistanceMeters(point.lat, point.lng) > 500) return;
        const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
        if (deduplicated.has(key)) return;
        deduplicated.set(key, {
          lng: point.lng,
          lat: point.lat,
          radius: point.radius,
          uncertainty: Math.round(Math.max(point.radius * .12, 2)),
          confidence: curve.confidence >= .85 ? 'High' : curve.confidence >= .65 ? 'Medium' : 'Low',
          direction: curve.curve_direction || 'unknown',
          severity: curve.severity || 'moderate',
          curveType: curve.curve_type || 'curve',
          source: curve.data_source || 'India curve dataset',
          verificationStatus: curve.verification_status || 'unverified',
          recommended: Math.round(Math.sqrt(.65 * 9.81 * point.radius) * 3.6),
        });
      });
      curves = [...deduplicated.values()];
    } catch (_) {
      curves = [];
    }
  }
  const vehicleMarkerElement=elementForMarker('#70d8d1','V');
  if (route.length) window.vehicleMarker=new maplibregl.Marker({element:vehicleMarkerElement}).setLngLat(route[0]).addTo(map);
  const liveLocationElement=document.createElement('div');
  liveLocationElement.className='live-location-marker';
  liveLocationElement.style.display='none';
  window.liveLocationMarker=new maplibregl.Marker({element:liveLocationElement}).setLngLat(map.getCenter()).addTo(map);
  window.liveLocationMarker.getElement().style.display='none';
  renderSharpBendMarkers();
  document.getElementById('mapStatus').textContent=curves.length
    ? `${curves.length} imported bends loaded`
    : 'No imported bends · add GPS trace and bends CSV';
  updateHazard();
});

let vehicleType='car';
let scene,camera,renderer,model,animationFrame;
function buildVehicle(type) {
  scene=new THREE.Scene();
  camera=new THREE.PerspectiveCamera(35,1,.1,100);
  camera.position.set(3.2,2.2,4.5);
  camera.lookAt(0,.15,0);
  renderer=new THREE.WebGLRenderer({alpha:true,antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  const host=document.getElementById('vehicleCanvas');
  host.replaceChildren(renderer.domElement);
  renderer.setSize(host.clientWidth,host.clientHeight);
  const group=new THREE.Group();
  const bodyMaterial=new THREE.MeshStandardMaterial({color:0x70d8d1,metalness:.25,roughness:.35});
  if(type==='car') {
    const body=new THREE.Mesh(new THREE.BoxGeometry(2.55,.54,1.18),bodyMaterial); body.position.y=.55; group.add(body);
    const upper=new THREE.Mesh(new THREE.BoxGeometry(1.48,.42,1.08),new THREE.MeshStandardMaterial({color:0x70d8d1,metalness:.35,roughness:.22}));
    upper.position.set(-.22,.94,0); upper.scale.set(1,.9,.96); group.add(upper);
    const cabin=new THREE.Mesh(new THREE.BoxGeometry(.90,.52,.96),new THREE.MeshStandardMaterial({color:0x0a1722,metalness:.22,roughness:.08}));
    cabin.position.set(-.18,1.15,0); cabin.scale.set(.98,.78,.98); group.add(cabin);
    [-.70,.72].forEach(x=>{
      const roofRail=new THREE.Mesh(new THREE.BoxGeometry(.08,.06,1.02),new THREE.MeshStandardMaterial({color:0x101820,metalness:.6,roughness:.18}));
      roofRail.position.set(x,1.43,0); group.add(roofRail);
    });
    const hood=new THREE.Mesh(new THREE.BoxGeometry(.72,.18,1.10),bodyMaterial); hood.position.set(.95,.82,0); hood.rotation.z=-.06; group.add(hood);
    const grille=new THREE.Mesh(new THREE.BoxGeometry(.05,.25,.70),new THREE.MeshStandardMaterial({color:0x090d12,metalness:.5,roughness:.28}));
    grille.position.set(1.29,.52,0); group.add(grille);
    [-.38,.38].forEach(z=>{
      const headlamp=new THREE.Mesh(new THREE.BoxGeometry(.04,.09,.26),new THREE.MeshStandardMaterial({color:0xeafcff,emissive:0x70d8d1,emissiveIntensity:.8}));
      headlamp.position.set(1.26,.75,z); group.add(headlamp);
    });
    const wheelMaterial=new THREE.MeshStandardMaterial({color:0x090d12,metalness:.1,roughness:.75});
    [[-.78,-.58],[.78,-.58],[-.78,.58],[.78,.58]].forEach(([x,z])=>{
      const wheel=new THREE.Mesh(new THREE.CylinderGeometry(.34,.34,.20,24),wheelMaterial);
      wheel.rotation.x=Math.PI/2; wheel.position.set(x,.34,z); group.add(wheel);
      const rim=new THREE.Mesh(new THREE.CylinderGeometry(.20,.20,.21,12),new THREE.MeshStandardMaterial({color:0xbfc8ca,metalness:.85,roughness:.15}));
      rim.rotation.x=Math.PI/2; rim.position.set(x,.34,z); group.add(rim);
      const brake=new THREE.Mesh(new THREE.CylinderGeometry(.11,.11,.22,16),new THREE.MeshStandardMaterial({color:0xffb35c,metalness:.6,roughness:.25}));
      brake.rotation.x=Math.PI/2; brake.position.set(x,.34,z); group.add(brake);
    });
    const spoiler=new THREE.Mesh(new THREE.BoxGeometry(.55,.07,.12),new THREE.MeshStandardMaterial({color:0x101820,metalness:.7,roughness:.18}));
    spoiler.position.set(-1.12,.72,.48); group.add(spoiler);
  } else {
    const wheelMaterial=new THREE.MeshStandardMaterial({color:0x090d12,roughness:.62,metalness:.12});
    [-.82,.82].forEach(x=>{
      const wheel=new THREE.Mesh(new THREE.TorusGeometry(.42,.095,16,32),wheelMaterial);
      wheel.rotation.y=Math.PI/2; wheel.position.set(x,.42,0); group.add(wheel);
      const rim=new THREE.Mesh(new THREE.TorusGeometry(.25,.025,10,24),new THREE.MeshStandardMaterial({color:0x75c7c1,metalness:.75,roughness:.18}));
      rim.rotation.y=Math.PI/2; rim.position.set(x,.42,0); group.add(rim);
      const hub=new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,.14,16),new THREE.MeshStandardMaterial({color:0xcfd5d5,metalness:.82,roughness:.12}));
      hub.rotation.z=Math.PI/2; hub.position.set(x,.42,0); group.add(hub);
    });
    const frameMaterial=new THREE.MeshStandardMaterial({color:0xcbd3d4,metalness:.7,roughness:.22});
    const lower=new THREE.Mesh(new THREE.CylinderGeometry(.055,.055,1.55,12),frameMaterial); lower.rotation.z=Math.PI/2; lower.position.set(0,.62,0); group.add(lower);
    const fork=new THREE.Mesh(new THREE.CylinderGeometry(.042,.042,1.20,12),frameMaterial); fork.rotation.z=-.48; fork.position.set(.70,.78,0); group.add(fork);
    const rearFrame=new THREE.Mesh(new THREE.CylinderGeometry(.038,.038,.98,12),frameMaterial); rearFrame.rotation.z=.58; rearFrame.position.set(-.48,.72,0); group.add(rearFrame);
    const engine=new THREE.Mesh(new THREE.BoxGeometry(.72,.48,.58),new THREE.MeshStandardMaterial({color:0x27343b,metalness:.55,roughness:.32}));
    engine.position.set(.10,.62,0); group.add(engine);
    const tank=new THREE.Mesh(new THREE.SphereGeometry(.34,20,14),new THREE.MeshStandardMaterial({color:0x55b7b0,metalness:.28,roughness:.24}));
    tank.scale.set(1.30,.72,.78); tank.position.set(-.02,1.02,0); group.add(tank);
    const seat=new THREE.Mesh(new THREE.BoxGeometry(.72,.12,.44),new THREE.MeshStandardMaterial({color:0x10131a,roughness:.82}));
    seat.position.set(-.42,1.08,0); group.add(seat);
    const tail=new THREE.Mesh(new THREE.BoxGeometry(.50,.10,.38),new THREE.MeshStandardMaterial({color:0x55b7b0,metalness:.28,roughness:.24}));
    tail.position.set(-.72,.98,0); tail.rotation.z=.12; group.add(tail);
    const handle=new THREE.Mesh(new THREE.CylinderGeometry(.028,.028,.72,12),frameMaterial); handle.rotation.x=Math.PI/2; handle.position.set(.76,1.30,0); group.add(handle);
  }
  const light=new THREE.DirectionalLight(0xffffff,2); light.position.set(3,5,4); scene.add(light);
  scene.add(new THREE.AmbientLight(0x91a7b8,1.2),group);
  model=group; scene.add(model);
  function animate() {
    animationFrame=requestAnimationFrame(animate);
    model.rotation.y+=.006;
    renderer.render(scene,camera);
  }
  animate();
}
buildVehicle('car');
document.getElementById('vehicleSwitch').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-vehicle]');
  if(!button)return;
  vehicleType=button.dataset.vehicle;
  document.querySelectorAll('[data-vehicle]').forEach(item=>item.classList.toggle('active',item===button));
  cancelAnimationFrame(animationFrame);
  buildVehicle(vehicleType);
});

let voiceEnabled=true;
document.getElementById('voiceButton').addEventListener('click',(event)=>{
  voiceEnabled=!voiceEnabled; window.BlackspotVoice.setEnabled(voiceEnabled);
  event.target.textContent=voiceEnabled?'Voice on':'Voice muted';
});
document.getElementById('pitchButton').addEventListener('click',(event)=>{
  const pitched=map.getPitch()>20;
  map.easeTo({pitch:pitched?0:62,bearing:pitched?0:-22,duration:900});
  event.target.textContent=pitched?'Show 2D':'Show 3D';
});
document.getElementById('mobilePanel').addEventListener('click',()=>document.getElementById('leftPanel').classList.toggle('open'));
document.getElementById('routeStartButton').addEventListener('click',()=>{
  showSelectedRoute();
});

async function showSelectedRoute() {
  const startName=document.getElementById('routeStartInput').value.trim();
  const endName=document.getElementById('routeEndInput').value.trim();
  if(!startName || !endName){
    route=[];
    curves=[];
    blackspots=[];
    sharpBendMarkers.forEach((marker)=>marker.remove());
    sharpBendMarkers=[];
    routeEndpointMarkers.forEach((marker)=>marker.remove());
    routeEndpointMarkers=[];
    if(map.getSource('route')){
      map.getSource('route').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
    }
    if(window.vehicleMarker) window.vehicleMarker.getElement().style.display='none';
    document.getElementById('mapStatus').textContent='Enter both a source and destination';
    return;
  }
  const button=document.getElementById('routeStartButton');
  button.textContent='Finding route…';
  button.disabled=true;
  try{
    const [starts,destinations]=await Promise.all([
      window.BlackspotAPI.get(`/api/geocode/?q=${encodeURIComponent(startName)}`),
      window.BlackspotAPI.get(`/api/geocode/?q=${encodeURIComponent(endName)}`),
    ]);
    const start=starts.results?.[0];
    const end=destinations.results?.[0];
    if(!start || !end) throw new Error('Source or destination could not be resolved');
    const data=await window.BlackspotAPI.get(`/api/routes/?start_lat=${start.lat}&start_lon=${start.lon}&end_lat=${end.lat}&end_lon=${end.lon}`);
    const selected=data.routes?.find((item)=>item.id==='charmadi-ghat') || data.routes?.[0];
    if(!selected?.coordinates?.length) throw new Error('No road route was found');
    route=selected.coordinates.map((point)=>[point.lon,point.lat]);
    renderRouteEndpointMarkers(route[0],route[route.length-1]);
    const geojson={type:'Feature',properties:{},geometry:{type:'LineString',coordinates:route}};
    if(map.getSource('route')) map.getSource('route').setData(geojson);
    else{
      map.addSource('route',{type:'geojson',data:geojson});
      map.addLayer({id:'route-glow',type:'line',source:'route',paint:{'line-color':'#70d8d1','line-width':10,'line-opacity':.12}});
      map.addLayer({id:'route-line',type:'line',source:'route',paint:{'line-color':'#70d8d1','line-width':4}});
    }
    const longitudeValues=route.map((point)=>point[0]);
    const latitudeValues=route.map((point)=>point[1]);
    map.fitBounds([[Math.min(...longitudeValues),Math.min(...latitudeValues)],[Math.max(...longitudeValues),Math.max(...latitudeValues)]],{padding:55,duration:900});
    if(window.vehicleMarker) window.vehicleMarker.setLngLat(route[0]);
    routeIndex=0;
    curves=curves.filter((curve)=>pointToRouteDistanceMeters(curve.lat,curve.lng)<=500);
    blackspots=blackspots.filter((spot)=>pointToRouteDistanceMeters(spot.lat,spot.lng)<=500);
    if(!curves.length){
      try{
        const indiaCurves=await window.BlackspotAPI.get('/api/dataset/curves/');
        const seen=new Set();
        curves=indiaCurves.filter((curve)=>{
          const lat=Number(curve.latitude),lng=Number(curve.longitude),radius=Number(curve.radius_m);
          if(!Number.isFinite(lat)||!Number.isFinite(lng)||pointToRouteDistanceMeters(lat,lng)>500)return false;
          const severity=String(curve.severity||'').toLowerCase();
          const curveType=String(curve.curve_type||'').toLowerCase();
          if(severity!=='sharp'&&severity!=='hairpin'&&curveType!=='hairpin'&&radius>=80)return false;
          const key=`${lat.toFixed(5)},${lng.toFixed(5)}`;
          if(seen.has(key))return false;
          seen.add(key);
          return true;
        }).map((curve)=>({
          lng:Number(curve.longitude),lat:Number(curve.latitude),radius:Number(curve.radius_m),
          uncertainty:Math.round(Math.max(Number(curve.radius_m)*.12,2)),
          confidence:Number(curve.confidence)>=.85?'High':Number(curve.confidence)>=.65?'Medium':'Low',
          direction:curve.curve_direction||'unknown',severity:curve.severity||'moderate',
          curveType:curve.curve_type||'curve',source:curve.data_source||'India curve dataset',
          verificationStatus:curve.verification_status||'unverified',
          recommended:Math.round(Math.sqrt(.65*9.81*Number(curve.radius_m))*3.6),
        }));
      }catch(_){curves=[];}
    }
    renderSharpBendMarkers();
    document.getElementById('mapStatus').textContent=`${start.name} → ${end.name}`;
    localStorage.setItem('blackspotRouteSelection',JSON.stringify({
      start:{name:start.name,lat:start.lat,lon:start.lon},
      destination:{name:end.name,lat:end.lat,lon:end.lon},
    }));
    localStorage.setItem('blackspotLiveRouteSelection',JSON.stringify({start,end,route}));
  }catch(error){
    route=[];
    if(map.getSource('route')) map.getSource('route').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
    document.getElementById('mapStatus').textContent=error.message;
  }finally{
    button.textContent='Show route';
    button.disabled=false;
  }
}

let routeIndex=0, demoRunning=false, currentSpeed=48;
let hazardIndex=0;
const alertState = new Map();
let cruisingSpeed = Number(localStorage.getItem('blackspotCruisingSpeed')) || 80;
const cruisingInput=document.getElementById('cruisingSpeed');
cruisingInput.value=cruisingSpeed;
cruisingInput.addEventListener('change',()=>{
  cruisingSpeed=Math.max(0,Math.min(180,Number(cruisingInput.value)||0));
  localStorage.setItem('blackspotCruisingSpeed',String(cruisingSpeed));
  updateHazard();
});
function normalizeCurve(curve) {
  if (typeof curve.confidence === 'number') {
    curve.confidence = curve.confidence >= .85 ? 'High' : curve.confidence >= .65 ? 'Medium' : 'Low';
  }
  if (!curve.confidence) curve.confidence='Medium';
  if (!curve.uncertainty) curve.uncertainty=Math.round(curve.radius * .12);
  if (curve.confidence === 'Low') curve.recommended=Math.min(curve.recommended, Math.round(Math.sqrt(.65*9.81*Math.max(5,curve.radius-curve.uncertainty))*3.6));
  return curve;
}
function haversine(a,b){
  const R=6371000,p=Math.PI/180;
  const dlat=(b[1]-a[1])*p,dlon=(b[0]-a[0])*p;
  const x=Math.sin(dlat/2)**2+Math.cos(a[1]*p)*Math.cos(b[1]*p)*Math.sin(dlon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function nearestRouteIndex(lon, lat) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  route.forEach((point, index) => {
    const distance = haversine([lon, lat], [point[0], point[1]]);
    if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
  });
  return nearestIndex;
}
function updateHazard() {
  if (!route.length) {
    document.getElementById('hazardDistance').textContent='—';
    document.getElementById('recommendedSpeed').textContent='—';
    document.getElementById('curveRadius').textContent='—';
    document.getElementById('curveConfidence').textContent='—';
    document.getElementById('warningTitle').textContent='No route loaded';
    document.getElementById('warningText').textContent='Select a route or enable GPS to load the active road.';
    document.getElementById('warningConfidence').textContent='Waiting for route';
    document.getElementById('hazardBadge').textContent='No hazard';
    document.getElementById('hazardBadge').className='risk-badge low';
    document.getElementById('cruiseCount').textContent=`0 of 0 bends exceed safe speed at ${cruisingSpeed} km/h`;
    return;
  }
  const marker=route[Math.min(routeIndex,route.length-1)];
  const current=[marker[0],marker[1]];
  curves.forEach(normalizeCurve);
  if(!curves.length){
    document.getElementById('hazardDistance').textContent='—';
    document.getElementById('recommendedSpeed').textContent='—';
    document.getElementById('curveRadius').textContent='No bend file';
    document.getElementById('curveConfidence').textContent='Not loaded';
    document.getElementById('warningTitle').textContent='No bends loaded';
    document.getElementById('warningText').textContent='Upload a GPS trace and known bends CSV on the Data page.';
    document.getElementById('warningConfidence').textContent='Waiting for CSV files';
    document.getElementById('hazardBadge').textContent='No hazard';
    document.getElementById('hazardBadge').className='risk-badge low';
    document.getElementById('cruiseCount').textContent=`0 of 0 bends exceed safe speed at ${cruisingSpeed} km/h`;
    return;
  }
  let nearest=curves[0],nearestDistance=Infinity;
  const currentRouteIndex = nearestRouteIndex(current[0], current[1]);
  for(const curve of curves){
    const distance=haversine(current,[curve.lng,curve.lat]);
    const curveRouteIndex=nearestRouteIndex(curve.lng,curve.lat);
    if(curveRouteIndex>=currentRouteIndex && distance<nearestDistance){nearestDistance=distance;nearest=curve;}
  }
  document.getElementById('hazardDistance').textContent=Math.round(nearestDistance);
  document.getElementById('recommendedSpeed').textContent=Math.min(55,nearest.recommended);
  recordApproachObservation(currentSpeed, nearest.recommended);
  document.getElementById('curveRadius').textContent=`${Math.round(nearest.radius)} ± ${nearest.uncertainty}`;
  document.getElementById('curveConfidence').textContent=nearest.confidence;
  document.getElementById('warningTitle').textContent=`${nearest.severity==='sharp'?'Sharp':'Approaching'} ${nearest.direction} bend`;
  document.getElementById('warningConfidence').textContent=`Confidence: ${nearest.confidence}${nearest.confidence==='Low'?' — verify on site':''}`;
  const badge=document.getElementById('hazardBadge');
  badge.textContent=nearest.radius<80?'High risk':'Medium risk';
  badge.className=`risk-badge ${nearest.radius<80?'high':'medium'}`;
  const warningCard=document.getElementById('warningCard');
  warningCard.classList.toggle('low-confidence',nearest.confidence==='Low');
  const exceedCount=curves.filter((curve)=>shouldAlert(normalizeCurve(curve),currentSpeed,cruisingSpeed).alert).length;
  document.getElementById('cruiseCount').textContent=`${exceedCount} of ${curves.length} bends exceed safe speed at ${cruisingSpeed} km/h`;

  const bendKey=`${nearest.lat},${nearest.lng}`;
  const alert=alertState.get(bendKey)||{count:0,confirmed:false};
  const brakingDistance=brakingAlertDistance(currentSpeed);
  const thresholdDecision=shouldAlert(nearest,currentSpeed,currentSpeed);
  const canAlert=isHighRiskBend(nearest) || thresholdDecision.alert;
  if(nearest.confidence==='Low' && nearest.severity==='gentle'){
    // Low-confidence gentle bends are silent in the live alert system.
  } else if(nearest.severity!=='gentle' && currentSpeed>nearest.recommended*(isHighRiskBend(nearest)?1:1.10) && nearestDistance<=brakingDistance && alert.count<2 && canAlert){
    alert.count+=1;
    alert.confirmed=false;
    alertState.set(bendKey,alert);
    const message=`You are doing ${currentSpeed}. Safe speed for this bend is ${nearest.recommended}. Slow down.`;
    document.getElementById('warningCard').classList.add('speed-alert');
    document.getElementById('warningText').textContent=message;
    window.BlackspotVoice.speak(message);
  } else if(nearestDistance<=90 && alert.count===1 && currentSpeed>nearest.recommended*(isHighRiskBend(nearest)?1:1.10)){
    alert.count=2;
    alertState.set(bendKey,alert);
    const message=`You are doing ${currentSpeed}. Safe speed for this bend is ${nearest.recommended}. Slow down.`;
    document.getElementById('warningText').textContent=message;
    window.BlackspotVoice.speak(message);
  } else if(alert.count>0 && currentSpeed<=nearest.recommended){
    alert.confirmed=true;
    alertState.set(bendKey,alert);
    document.getElementById('warningCard').classList.remove('speed-alert');
    document.getElementById('warningText').textContent='Speed is safe';
    window.BlackspotVoice.speak('Speed is safe');
  }
  window.BlackspotAPI.post('/api/safe-speed/',{radius:nearest.radius,vehicle_type:vehicleType,banking_ratio:0,friction:.65,gradient:0})
    .then(data=>document.getElementById('speedNote').textContent=` conservative · ${data.uncertainty}`)
    .catch(()=>{});
  if(nearestDistance<350){
    window.BlackspotVoice.speak(`Warning! ${nearest.severity} ${nearest.direction} bend ahead. Distance ${Math.round(nearestDistance)} metres. Current speed ${currentSpeed} kilometres per hour. Recommended approach speed ${nearest.recommended} kilometres per hour.`);
  }
  function recordApproachObservation(actual, recommended) {
    if (!Number.isFinite(actual) || actual < 0 || !Number.isFinite(recommended) || recommended <= 0) return;
    let observations;
    try { observations=JSON.parse(localStorage.getItem('blackspotApproachObservations')||'[]'); } catch (_) { observations=[]; }
    observations.push({timestamp:Date.now(),actual,recommended,accuracy:Math.max(0,Math.min(100,100-Math.abs(actual-recommended)/recommended*100))});
    observations=observations.slice(-100);
    localStorage.setItem('blackspotApproachObservations',JSON.stringify(observations));
  }
}
setInterval(()=>{
  if(!demoRunning || !route.length)return;
  routeIndex=(routeIndex+1)%route.length;
  const point=route[routeIndex];
  if(window.vehicleMarker)window.vehicleMarker.setLngLat(point);
  map.easeTo({center:point,duration:900});
  const previous=route[Math.max(0,routeIndex-1)];
  const heading=Math.atan2(point[0]-previous[0],point[1]-previous[1])*180/Math.PI;
  if(window.vehicleMarker)window.vehicleMarker.setRotation(heading);
  currentSpeed=routeIndex%4===0?36:routeIndex%3===0?54:48;
  document.getElementById('currentSpeed').textContent=currentSpeed;
  updateHazard();
},1300);
document.getElementById('demoButton').addEventListener('click',async (event)=>{
  if(!route.length){
    document.getElementById('routeStartInput').value='Kottigehara, Karnataka';
    document.getElementById('routeEndInput').value='Ujire, Karnataka';
    await showSelectedRoute();
  }
  if(!route.length)return;
  demoRunning=!demoRunning;
  if(window.liveLocationMarker)window.liveLocationMarker.getElement().style.display='none';
  event.target.textContent=demoRunning?'Pause demo':'Resume demo';
});

let watchId=null;
document.getElementById('gpsButton').addEventListener('click',(event)=>{
  if(!('geolocation'in navigator)){
    document.getElementById('gpsStatus').textContent='GPS unavailable';
    return;
  }
  demoRunning=false;
  watchId=navigator.geolocation.watchPosition((position)=>{
    const {latitude,longitude,speed,heading,accuracy}=position.coords;
    const point=[longitude,latitude];
    routeIndex=nearestRouteIndex(longitude,latitude);
    if(window.vehicleMarker)window.vehicleMarker.setLngLat(point).setRotation(heading||0);
    if(window.liveLocationMarker){
      window.liveLocationMarker.setLngLat(point).setRotation(heading||0);
      window.liveLocationMarker.getElement().style.display='block';
    }
    map.easeTo({center:point,duration:600});
    document.getElementById('gpsStatus').textContent=`GPS active · ±${Math.round(accuracy)} m`;
    const gpsSpeed=speed?Math.min(55,Math.round(speed*3.6)):null;
    document.getElementById('currentSpeed').textContent=gpsSpeed??'—';
    if(gpsSpeed){
      const recommendedElement=document.getElementById('recommendedSpeed');
      const recommended=Number(recommendedElement.textContent)||24;
      recordApproachObservation(gpsSpeed,recommended);
    }
    window.BlackspotAPI.post('/api/gps/',{latitude,longitude,speed:speed?speed*3.6:null,heading,accuracy}).catch(()=>{});
  },()=>{
    document.getElementById('gpsStatus').textContent='GPS permission denied or unavailable';
  },{
    enableHighAccuracy:true,
    maximumAge:2000,
    timeout:10000,
  });
  event.target.textContent='GPS active';
});
updateHazard();
