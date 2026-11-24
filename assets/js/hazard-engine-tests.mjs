import {
  detectBends,
  brakingAlertDistance,
  shouldAlert,
  validateKnownBends,
  haversineMeters,
} from './hazard-engine.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

function generateBendsRoad(radii) {
  const random = seededNoise(912735);
  const points = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  for (const radius of radii) {
    for (let distance = 0; distance < 100; distance += 5) {
      x += 5 * Math.cos(heading);
      y += 5 * Math.sin(heading);
      points.push({ lat: y / 111000 + 13, lon: x / (111000 * Math.cos(13 * Math.PI / 180)) + 75 });
    }
    const arcLength = radius * Math.PI / 2;
    for (let distance = 0; distance < arcLength; distance += 5) {
      x += 5 * Math.cos(heading);
      y += 5 * Math.sin(heading);
      points.push({ lat: y / 111000 + 13, lon: x / (111000 * Math.cos(13 * Math.PI / 180)) + 75 });
      heading += 5 / radius;
    }
  }
  for (const point of points) {
    const latNoise = random() * 3 / 111000;
    const lonNoise = random() * 3 / (111000 * Math.cos(13 * Math.PI / 180));
    point.lat += latNoise;
    point.lon += lonNoise;
  }
  return points;
}

const radii = [45, 60, 90, 120, 200];
const noisyRoad = generateBendsRoad(radii);
const detected = detectBends(noisyRoad);
console.log(JSON.stringify(detected.map((bend) => ({
  radius: bend.radius,
  uncertainty: bend.uncertainty,
  confidence: bend.confidence,
  points: bend.pointCount,
}))));

const straight = [];
for (let i = 0; i < 400; i += 5) {
  const random = seededNoise(100 + i);
  straight.push({
    lat: 13 + i / 111000,
    lon: 75 + (random() * 3) / (111000 * Math.cos(13 * Math.PI / 180)),
  });
}
const straightDetected = detectBends(straight);

const highRisk = { severity: 'sharp', radius: 50, recommended: 35, confidence: 'High' };
const lowRisk = { severity: 'gentle', radius: 220, recommended: 50, confidence: 'High' };
const braking80 = brakingAlertDistance(80);
const at80 = shouldAlert(highRisk, 80).alert;
const at30 = shouldAlert(highRisk, 30).alert;
const highRiskRadii = radii.filter((radius) => radius < 80);
const everyHighRiskAt80 = highRiskRadii.every((radius) => shouldAlert({
  severity: 'sharp',
  radius,
  recommended: Math.max(5, Math.round(Math.sqrt(.65 * 9.81 * radius) * 3.6)),
  confidence: 'High',
}, 80).alert);
const noHighRiskAt30 = highRiskRadii.every((radius) => !shouldAlert({
  severity: 'sharp',
  radius,
  recommended: Math.max(5, Math.round(Math.sqrt(.65 * 9.81 * radius) * 3.6)),
  confidence: 'High',
}, 30).alert);

const known = radii.map((radius, index) => ({
  lat: detected[index]?.lat ?? 13,
  lon: detected[index]?.lon ?? 75,
  trueRadius: radius,
}));
const validation = validateKnownBends(detected, known);

assert(detected.length > 0, 'synthetic road should detect bends');
assert(straightDetected.length === 0, `straight noisy road must have zero bends; got ${straightDetected.length}`);
assert(at80, '80 km/h should exceed the high-risk threshold');
assert(!at30, '30 km/h should not alert');
assert(!shouldAlert(lowRisk, 80).alert, 'low-risk bend must stay silent');
assert(braking80 > 100, 'braking distance alert threshold must include braking and margin');
assert(everyHighRiskAt80, 'every high-risk bend should alert at 80 km/h');
assert(noHighRiskAt30, 'no high-risk bend should alert at 30 km/h');
assert(detected.every((bend) => bend.confidence === 'Low'), 'synthetic noisy bends should remain low confidence');

const meanError = detected.length
  ? detected.reduce((sum, bend, index) => sum + Math.abs(bend.radius - radii[index % radii.length]) / radii[index % radii.length] * 100, 0) / detected.length
  : 0;

console.log('\nAcceptance test results');
console.log(`Synthetic radii: ${detected.map((bend) => `${bend.radius} m / ${bend.confidence}`).join(', ')}`);
console.log(`Mean radius error: ${meanError.toFixed(2)}%`);
console.log(`Straight noisy road bends: ${straightDetected.length}`);
console.log(`80 km/h alert: ${at80}; required braking distance: ${braking80.toFixed(1)} m`);
console.log(`30 km/h alert: ${at30}`);
console.log(`Every high-risk bend at 80 km/h: ${everyHighRiskAt80}; none at 30 km/h: ${noHighRiskAt30}`);
console.log(`Low-risk silence: ${!shouldAlert(lowRisk, 80).alert}`);
console.log(`Validation: ${validation.found}/${validation.total}, mean error ${validation.meanRadiusErrorPercent.toFixed(2)}%, false bends ${validation.falseBends}`);
