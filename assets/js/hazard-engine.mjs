const DEG_TO_RAD = Math.PI / 180;

export function haversineMeters(a, b) {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function localEastNorth(points) {
  const origin = points[0];
  return points.map((point) => ({
    x: (point.lon - origin.lon) * DEG_TO_RAD * 6371000 * Math.cos(origin.lat * DEG_TO_RAD),
    y: (point.lat - origin.lat) * DEG_TO_RAD * 6371000,
  }));
}

export function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i - 1] !== '\\') quoted = !quoted;
      else if (char === ',' && !quoted) { values.push(value.trim()); value = ''; }
      else value += char;
    }
    values.push(value.trim());
    return values;
  });
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => header.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim()])));
}

export function parseGpsCsv(text) {
  return parseCsv(text).map((row) => ({
    lat: Number(row.latitude ?? row.lat),
    lon: Number(row.longitude ?? row.lon),
    altitude: Number(row.altitude),
  })).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

function movingAverage(points, windowSize) {
  const radius = Math.floor(windowSize / 2);
  return points.map((_, index) => {
    const slice = points.slice(Math.max(0, index - radius), Math.min(points.length, index + radius + 1));
    return {
      lat: median(slice.map((point) => point.lat)),
      lon: median(slice.map((point) => point.lon)),
    };
  });
}

function segmentHeading(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function angleDifference(a, b) {
  let difference = b - a;
  while (difference > Math.PI) difference -= 2 * Math.PI;
  while (difference < -Math.PI) difference += 2 * Math.PI;
  return difference;
}

function estimateNoise(points, spacing) {
  if (points.length < 20) return Math.max(1, median(points.map((_, i) => i ? haversineMeters(points[i - 1], points[i]) : 0)));
  const localResiduals = [];
  for (let i = 10; i < points.length - 10; i += 10) {
    const xy = localEastNorth(points.slice(i - 10, i + 11));
    const first = xy[0];
    const last = xy[xy.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) continue;
    for (const point of xy) {
      // Distance of a point from its local least-squares line is reported scatter.
      const cross = Math.abs(dx * (first.y - point.y) - dy * (first.x - point.x));
      localResiduals.push(cross / Math.sqrt(lengthSquared));
    }
  }
  return median(localResiduals) || median(spacing);
}

function curvatureSeries(points, windowSize) {
  const smoothed = movingAverage(points, windowSize);
  const xy = localEastNorth(smoothed);
  const curvatures = [];
  const headings = [];
  for (let i = 1; i < xy.length; i += 1) {
    const previous = xy[i - 1];
    const current = xy[i];
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (distance > 0) headings[i] = segmentHeading(previous, current);
  }
  for (let i = windowSize; i < smoothed.length - windowSize; i += 1) {
    const before = headings[i - windowSize];
    const after = headings[i + windowSize];
    if (!Number.isFinite(before) || !Number.isFinite(after)) { curvatures[i] = 0; continue; }
    const headingChange = Math.abs(angleDifference(before, after));
    const distance = haversineMeters(smoothed[i - windowSize], smoothed[i + windowSize]);
    curvatures[i] = distance ? headingChange / distance : 0;
  }
  return { smoothed, curvatures };
}

export function detectBends(points, options = {}) {
  if (points.length < 12) return [];
  const spacings = [];
  for (let i = 1; i < points.length; i += 1) spacings.push(haversineMeters(points[i - 1], points[i]));
  const spacing = median(spacings.filter((value) => value > 0));
  const gpsNoise = estimateNoise(points, spacing);
  const noiseCurvature = spacing > 0 ? (gpsNoise / spacing) / spacing : 0.006;
  const threshold = Math.max(1 / 500, Math.min(noiseCurvature * 0.22, 1 / 180));
  const windows = [3, 5, 9];
  const series = windows.map((windowSize) => curvatureSeries(points, windowSize));
  const clusterCandidates = [];

  for (let i = 9; i < points.length - 9; i += 1) {
    const values = series.map((item) => item.curvatures[i] || 0);
    const curvature = median(values);
    if (curvature < threshold) continue;
    clusterCandidates.push({ index: i, curvature });
  }

  const clusters = [];
  let active = null;
  for (const candidate of clusterCandidates) {
    if (!active || candidate.index > active.end + 3) {
      if (active) clusters.push(active);
      active = { start: candidate.index, end: candidate.index, candidates: [candidate] };
    } else {
      active.end = candidate.index;
      active.candidates.push(candidate);
    }
  }
  if (active) clusters.push(active);

  const bends = [];
  for (const cluster of clusters) {
    const count = cluster.end - cluster.start + 1;
    if (count < 8) continue;
    const strongest = cluster.candidates.reduce((best, candidate) => candidate.curvature > best.curvature ? candidate : best);
    const inside = cluster.candidates.length;
    const radii = windows.map((windowSize, index) => {
      const { curvatures } = series[index];
      const selected = curvatures.slice(cluster.start, cluster.end + 1).filter((value) => value >= threshold);
      const curvatureValue = median(selected);
      return curvatureValue > 0 ? 1 / curvatureValue : null;
    }).filter((radius) => Number.isFinite(radius) && radius > 0);
    if (!radii.length) continue;
    const rawRadius = median(radii);
    const windowSpread = radii.length > 1 ? (Math.max(...radii) - Math.min(...radii)) / 2 : 0;
    const noiseEffect = rawRadius * 0.65 * gpsNoise / Math.max(spacing, 1);
    const spacingEffect = rawRadius * spacing / Math.max(inside * spacing, 1);
    const uncertainty = Math.sqrt(noiseEffect ** 2 + spacingEffect ** 2 + windowSpread ** 2);
    const uncertaintyPercent = rawRadius ? uncertainty / rawRadius : 1;
    let confidence = 'Low';
    if (uncertaintyPercent < 0.15 && inside >= 8) confidence = 'High';
    else if (uncertaintyPercent < 0.35) confidence = 'Medium';

    const radiusLower = Math.max(5, rawRadius - uncertainty);
    const baseSafeSpeed = Math.sqrt(0.65 * 9.81 * rawRadius) * 3.6;
    const lowSafeSpeed = Math.sqrt(0.65 * 9.81 * radiusLower) * 3.6;
    const safeSpeed = confidence === 'Low' ? lowSafeSpeed : baseSafeSpeed;
    const center = points[Math.min(points.length - 1, strongest.index)];
    bends.push({
      lat: center.lat,
      lon: center.lon,
      radius: Math.round(rawRadius),
      radiusLower: Math.round(radiusLower),
      uncertainty: Math.round(uncertainty),
      confidence,
      uncertaintyPercent: Number(uncertaintyPercent.toFixed(3)),
      pointCount: inside,
      gpsNoise: Number(gpsNoise.toFixed(2)),
      spacing: Number(spacing.toFixed(1)),
      recommended: Math.max(5, Math.round(Math.min(55, safeSpeed))),
      direction: cluster.candidates[0].curvature ? 'approaching' : 'unknown',
      severity: rawRadius < 80 ? 'sharp' : rawRadius < 140 ? 'moderate' : 'gentle',
    });
  }
  return bends;
}

export function brakingAlertDistance(speedKph) {
  const speed = speedKph / 3.6;
  // Comfortable stopping distance: reaction distance + v^2/(2a), plus a 100 m margin.
  return 1.5 * speed + (speed * speed) / (2 * 2) + 100;
}

export function isHighRiskBend(bend) {
  return bend.severity === 'sharp' || bend.radius < 80;
}

export function shouldAlert(bend, currentSpeed, cruisingSpeed = currentSpeed) {
  if (!bend || bend.severity === 'gentle' || bend.confidence === 'Low' && bend.radius >= 200) return { alert: false, reason: 'low-risk' };
  const threshold = isHighRiskBend(bend) ? bend.recommended : bend.recommended * 1.10;
  const speed = Number(cruisingSpeed);
  return { alert: speed > threshold, threshold };
}

export function validateKnownBends(detected, known, maxDistanceMeters = 40) {
  let matched = 0;
  const used = new Set();
  const errors = [];
  for (const truth of known) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    detected.forEach((bend, index) => {
      if (used.has(index)) return;
      const distance = haversineMeters({ lat: bend.lat, lon: bend.lon }, { lat: truth.lat, lon: truth.lon });
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    if (bestIndex >= 0 && bestDistance <= maxDistanceMeters) {
      used.add(bestIndex);
      matched += 1;
      const trueRadius = Number(truth.trueRadius);
      if (Number.isFinite(trueRadius) && trueRadius > 0) {
        errors.push(Math.abs(detected[bestIndex].radius - trueRadius) / trueRadius * 100);
      }
    }
  }
  return {
    found: matched,
    total: known.length,
    detectionRate: known.length ? matched / known.length : 0,
    meanRadiusErrorPercent: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : 0,
    falseBends: Math.max(0, detected.length - matched),
  };
}
