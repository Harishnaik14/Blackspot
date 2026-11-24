import math
import numpy as np


EARTH_RADIUS_M = 6371000.0


def haversine_distance(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1-a)))


def project_xy(points):
    lat0 = float(np.mean([point['lat'] for point in points]))
    lon0 = float(np.mean([point['lon'] for point in points]))
    lat_scale = math.pi / 180 * EARTH_RADIUS_M
    lon_scale = lat_scale * math.cos(math.radians(lat0))
    return [( (lon-lon0)*lon_scale, (lat-lat0)*lat_scale) for lon, lat in ((point['lon'], point['lat']) for point in points)]


def heading_degrees(p1, p2):
    x = p2[0] - p1[0]
    y = p2[1] - p1[1]
    if abs(x) < 1e-6 and abs(y) < 1e-6:
        return None
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def detect_curves(points, minimum_segment_m=8.0, noise_distance_m=6.0):
    if len(points) < 5:
        return []
    clean = [points[0]]
    for point in points[1:]:
        if haversine_distance(clean[-1]['lat'], clean[-1]['lon'], point['lat'], point['lon']) >= noise_distance_m:
            clean.append(point)
    projected = project_xy(clean)
    if len(projected) < 5:
        return []
    headings = [
        heading_degrees(projected[index], projected[index+1])
        for index in range(len(projected)-1)
    ]
    candidates = []
    for index in range(2, len(headings)-2):
        if any(headings[index-2:index+3][i] is None for i in range(5)):
            continue
        heading_before = headings[index-2]
        heading_after = headings[index+2]
        delta = (heading_after - heading_before + 540) % 360 - 180
        if abs(delta) < 32:
            continue
        distance = haversine_distance(
            clean[index-1]['lat'], clean[index-1]['lon'],
            clean[index+2]['lat'], clean[index+2]['lon'],
        )
        if distance < minimum_segment_m:
            continue
        if distance < 120:
            continue
        radius = max(20.0, distance / max(math.tan(math.radians(abs(delta)/2)), 0.08))
        if radius > 220:
            continue
        consistency = 0
        for window_index in range(index-1, index+2):
            window_delta = (headings[window_index+1] - headings[window_index] + 540) % 360 - 180
            if (window_delta * delta) > 0:
                consistency += 1
        if consistency < 2:
            continue
        if not (radius < 75 and abs(delta) >= 55):
            continue
        severity = 'hairpin'
        confidence = min(
            0.92,
            0.52 + min(abs(delta)/120, 0.16) + consistency/25 + min(distance/1500, 0.08),
        )
        candidates.append({
            'latitude': clean[index]['lat'],
            'longitude': clean[index]['lon'],
            'radius': round(radius, 1),
            'direction': 'left' if delta < 0 else 'right',
            'severity': severity,
            'confidence': round(confidence, 2),
        })

    deduplicated = []
    for candidate in sorted(candidates, key=lambda item: item['latitude']):
        duplicate = False
        for existing in deduplicated:
            distance = haversine_distance(
                candidate['latitude'], candidate['longitude'],
                existing['latitude'], existing['longitude'],
            )
            if distance < 900:
                duplicate = True
                if candidate['confidence'] > existing['confidence']:
                    existing.update(candidate)
                break
        if not duplicate:
            deduplicated.append(candidate)
    return deduplicated
