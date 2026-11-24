import { detectBends, parseGpsCsv, parseCsv, validateKnownBends } from './hazard-engine.mjs';

function previewTable(headers, rows) {
  const previewRows = rows.slice(0, 8).map((row) => `<tr>${headers.map((header) => `<td>${row[header] ?? ''}</td>`).join('')}</tr>`).join('');
  return `<div style="overflow-x:auto;margin-top:10px"><table class="table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${previewRows}</tbody></table></div>`;
}

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function duplicateCount(records) {
  const seen = new Set();
  let duplicates = 0;
  records.forEach((record) => {
    const key = `${record.lat.toFixed(6)},${record.lon.toFixed(6)}`;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  });
  return duplicates;
}

async function bindCsv(fileId, buttonId, resultId, validator, storageKey) {
  const button = document.getElementById(buttonId);
  button.addEventListener('click', async () => {
    const file = document.getElementById(fileId).files[0];
    const output = document.getElementById(resultId);
    if (!file) { output.innerHTML = '<p style="color:var(--yellow)">Choose a CSV file first.</p>'; return; }
    output.textContent = 'Validating…';
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error('The CSV contains no data rows.');
      const result = validator(rows);
      if (result.error) throw new Error(result.error);
      localStorage.setItem(storageKey, JSON.stringify(result.records));
      const previewHeaders = result.headers.length ? result.headers : Object.keys(rows[0]);
      output.innerHTML = `
        <p><strong>${result.records.length}</strong> valid rows · <strong>${result.invalidRows}</strong> invalid rows · <strong>${result.duplicates}</strong> duplicates removed</p>
        ${previewTable(previewHeaders, result.preview)}`;
      if (storageKey === 'blackspotGpsRoute') {
        localStorage.setItem('blackspotGpsRouteFileName', file.name);
      }
    } catch (error) {
      output.innerHTML = `<p style="color:var(--red)">${error.message}</p>`;
    }
  });
}

bindCsv('ghatCurveFile', 'uploadGhatCurves', 'ghatCurveResult', (rows) => {
  const headers = ['latitude','longitude','radius','direction','curve_type','severity','road_name','data_source','verification_status','confidence'];
  const invalidKeys = [];
  const records = [];
  rows.forEach((row, index) => {
    const lat = Number(row.latitude ?? row.lat);
    const lon = Number(row.longitude ?? row.lon);
    const radius = Number(row.radius ?? row.radius_m ?? row.curve_radius_m);
    const direction = String(row.direction ?? row.curve_direction ?? '').toLowerCase();
    const curveType = String(row.curve_type ?? 'curve');
    const severity = String(row.severity ?? row.curve_classification ?? 'moderate');
    const confidenceValue = Number(row.confidence ?? 0.7);
    if (!validCoordinate(lat, lon) || !Number.isFinite(radius) || radius <= 0 ||
        !['left','right','unknown'].includes(direction) || !curveType || !severity) {
      invalidKeys.push(index);
      return;
    }
    records.push({
      lat, lon, radius, direction, curveType, severity,
      roadName: String(row.road_name ?? row.ghat_road_name ?? row.ghat_name ?? ''),
      source: String(row.data_source ?? row.source ?? 'User-uploaded curve database'),
      verificationStatus: String(row.verification_status ?? 'unverified'),
      confidence: Math.max(0, Math.min(1, Number.isFinite(confidenceValue) ? confidenceValue : 0.7)),
      pointCount: Number(row.point_count ?? 0),
    });
  });
  const duplicates = duplicateCount(records);
  const unique = [];
  const seen = new Set();
  records.forEach((record) => {
    const key = `${record.lat.toFixed(6)},${record.lon.toFixed(6)}`;
    if (!seen.has(key)) { seen.add(key); unique.push(record); }
  });
  return {
    records: unique,
    invalidRows: invalidKeys.length,
    duplicates,
    headers,
    preview: rows.slice(0, 8),
  };
}, 'blackspotGhatCurves');

bindCsv('gpsFile', 'uploadGps', 'gpsResult', (rows) => {
  const headers = ['latitude','longitude','altitude','timestamp','speed','road_name','direction'];
  const records = [];
  let invalidRows = 0;
  rows.forEach((row) => {
    const lat = Number(row.latitude ?? row.lat);
    const lon = Number(row.longitude ?? row.lon);
    const altitude = Number(row.altitude);
    const timestamp = String(row.timestamp ?? row.time ?? '').trim();
    const speed = Number(row.speed ?? row.vehicle_speed ?? row.speed_kph);
    if (!validCoordinate(lat, lon) || !timestamp) { invalidRows += 1; return; }
    records.push({
      lat, lon,
      altitude: Number.isFinite(altitude) ? altitude : null,
      timestamp,
      speed: Number.isFinite(speed) ? speed : null,
      roadName: String(row.road_name ?? ''),
      direction: String(row.direction ?? row.travel_direction ?? '').toLowerCase(),
    });
  });
  records.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    return Number.isFinite(ta) && Number.isFinite(tb) ? ta - tb : 0;
  });
  const duplicates = duplicateCount(records);
  const unique = [];
  const seen = new Set();
  records.forEach((record) => {
    const key = `${record.lat.toFixed(6)},${record.lon.toFixed(6)}`;
    if (!seen.has(key)) { seen.add(key); unique.push(record); }
  });
  return { records: unique, invalidRows, duplicates, headers, preview: rows.slice(0, 8) };
}, 'blackspotGpsRoute');

bindCsv('blackspotFile', 'uploadBlackspot', 'blackspotResult', (rows) => {
  const headers = ['latitude','longitude','accident_count','fatalities','source','verification_status'];
  const records = [];
  let invalidRows = 0;
  rows.forEach((row) => {
    const lat = Number(row.latitude ?? row.lat);
    const lon = Number(row.longitude ?? row.lon);
    const accidents = Number(row.accident_count ?? row.accidents);
    const fatalities = Number(row.fatalities);
    if (!validCoordinate(lat, lon) || !Number.isFinite(accidents) || accidents < 0 ||
        (row.fatalities !== undefined && (!Number.isFinite(fatalities) || fatalities < 0))) {
      invalidRows += 1;
      return;
    }
    records.push({
      lat, lon,
      accidentCount: accidents,
      fatalities: Number.isFinite(fatalities) ? fatalities : null,
      source: String(row.source ?? 'User-uploaded accident database'),
      verificationStatus: String(row.verification_status ?? 'unverified'),
    });
  });
  const duplicates = duplicateCount(records);
  const unique = [];
  const seen = new Set();
  records.forEach((record) => {
    const key = `${record.lat.toFixed(6)},${record.lon.toFixed(6)}`;
    if (!seen.has(key)) { seen.add(key); unique.push(record); }
  });
  return { records: unique, invalidRows, duplicates, headers, preview: rows.slice(0, 8) };
}, 'blackspotAccidentBlackspots');

document.getElementById('runValidation').addEventListener('click', async () => {
  const gpsFile=document.getElementById('knownGpsFile').files[0];
  const bendsFile=document.getElementById('knownBendsFile').files[0];
  const output=document.getElementById('validationResult');
  if(!gpsFile || !bendsFile){
    output.innerHTML='<p style="color:var(--yellow)">Choose both a GPS trace CSV and a known-bends CSV.</p>';
    return;
  }
  output.textContent='Running bend detection and matching…';
  try{
    const gpsPoints=parseGpsCsv(await gpsFile.text());
    const knownRows=parseCsv(await bendsFile.text()).map((row)=>({
      lat:Number(row.latitude ?? row.lat),
      lon:Number(row.longitude ?? row.lon),
      trueRadius:Number(row.true_radius ?? row.trueRadius ?? row.radius),
    })).filter((row)=>Number.isFinite(row.lat)&&Number.isFinite(row.lon));
    if(gpsPoints.length<12 || !knownRows.length){
      throw new Error('The files need at least 12 GPS points and one valid known bend.');
    }
    const detected=detectBends(gpsPoints);
    const validation=validateKnownBends(detected,knownRows);
    localStorage.setItem('blackspotValidationSummary',JSON.stringify(validation));
    output.innerHTML=`
      <p><strong>${validation.found}/${validation.total}</strong> detection rate (${(validation.detectionRate*100).toFixed(1)}%)</p>
      <p><strong>${validation.meanRadiusErrorPercent.toFixed(1)}%</strong> mean radius error</p>
      <p><strong>${validation.falseBends}</strong> false bends</p>
      <p style="color:var(--muted)">High: uncertainty below 15% of R and at least 8 points inside the bend. Medium: uncertainty below 35%. Low: remaining bends; verify on site.</p>
      <div style="overflow-x:auto;margin-top:10px"><table class="table"><thead><tr><th>Bend</th><th>Radius</th><th>Uncertainty</th><th>Confidence</th></tr></thead><tbody>${detected.map((bend,index)=>`<tr><td>${index+1}</td><td>${bend.radius} m</td><td>±${bend.uncertainty} m</td><td>${bend.confidence}${bend.confidence==='Low'?' — verify on site':''}</td></tr>`).join('')||'<tr><td colspan="4">No bends detected</td></tr>'}</tbody></table></div>
      <a class="button button-primary" href="driving.html" style="display:inline-block;margin-top:14px">Open live drive with these bends</a>`;
  }catch(error){
    output.innerHTML=`<p style="color:var(--red)">${error.message}</p>`;
  }
});
