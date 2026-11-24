import csv
import json
import math
import os
import sys
import time
from pathlib import Path

import httpx

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
CURVE_ENGINE_DIR = BASE_DIR / "backend"
sys.path.insert(0, str(CURVE_ENGINE_DIR))

from apps.curve_analysis.geometry import detect_curves, haversine_distance


HEADERS = {"User-Agent": "BlackspotWatchGeospatialDataset/1.0"}
KARNATAKA_BBOX = (11.5, 74.1, 18.5, 78.6)

SEED_GHATS = [
    {"name": "Agumbe Ghat", "highway": "NH-169A", "search": "Agumbe Ghat Karnataka", "district": "Udupi/Shivamogga"},
    {"name": "Charmadi Ghat", "highway": "NH-73", "search": "Charmadi Ghat Karnataka", "district": "Dakshina Kannada/Chikkamagaluru"},
    {"name": "Shiradi Ghat", "highway": "NH-75", "search": "Shiradi Ghat Karnataka", "district": "Dakshina Kannada/Hassan"},
    {"name": "Bisle Ghat", "highway": "SH", "search": "Bisle Ghat Karnataka", "district": "Hassan"},
    {"name": "Hulikal Ghat", "highway": "SH", "search": "Hulikal Ghat Karnataka", "district": "Shimoga"},
    {"name": "Balebare Ghat", "highway": "SH", "search": "Balebare Ghat Karnataka", "district": "Dakshina Kannada"},
    {"name": "Sampaje Ghat", "highway": "NH-275", "search": "Sampaje Ghat Karnataka", "district": "Dakshina Kannada"},
]


def geocode(query):
    with httpx.Client(timeout=30, headers=HEADERS) as client:
        response = client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 5, "countrycodes": "in"},
        )
        response.raise_for_status()
        for result in response.json():
            if result.get("lat") and result.get("lon"):
                return {
                    "latitude": float(result["lat"]),
                    "longitude": float(result["lon"]),
                    "display_name": result["display_name"],
                    "osm_id": result.get("osm_id"),
                    "osm_type": result.get("osm_type"),
                }
    return None


def overpass_named_roads():
    south, west, north, east = KARNATAKA_BBOX
    query = f"""
[out:json][timeout:180];
way["highway"]["name"~"(?i)(ghat|ghat road|ghat section|pass|hills|hill road|western ghats)",i]({south},{west},{north},{east});
out tags geom;
"""
    with httpx.Client(timeout=210, headers=HEADERS) as client:
        response = client.post("https://overpass-api.de/api/interpreter", data=query)
        response.raise_for_status()
        return response.json().get("elements", [])


def overpass_around(lat, lon, radius_m=35000):
    query = f"""
[out:json][timeout:120];
(
  way["highway"](around:{radius_m},{lat},{lon});
);
out tags geom;
"""
    with httpx.Client(timeout=150, headers=HEADERS) as client:
        response = client.post("https://overpass-api.de/api/interpreter", data=query)
        if response.status_code != 200:
            return []
        return response.json().get("elements", [])


def projected_heading(points, index):
    if index < 0 or index + 1 >= len(points):
        return None
    lat1, lon1 = points[index]["lat"], points[index]["lon"]
    lat2, lon2 = points[index + 1]["lat"], points[index + 1]["lon"]
    lat_mean = math.radians((lat1 + lat2) / 2)
    scale_lat = 6371000 * math.pi / 180
    scale_lon = scale_lat * math.cos(lat_mean)
    x1, y1 = lon1 * scale_lon, lat1 * scale_lat
    x2, y2 = lon2 * scale_lon, lat2 * scale_lat
    dx, dy = x2 - x1, y2 - y1
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return None
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


def classify_angle_change(points):
    if len(points) < 5:
        return []
    sample_distance_m = 30
    cleaned = [points[0]]
    for point in points[1:]:
        previous = cleaned[-1]
        if haversine_distance(previous["lat"], previous["lon"], point["lat"], point["lon"]) >= sample_distance_m:
            cleaned.append(point)
    if len(cleaned) < 5:
        return []

    headings = [projected_heading(cleaned, index) for index in range(len(cleaned)-1)]
    candidates = []
    for index in range(2, len(headings)-2):
        window = headings[index-2:index+3]
        if any(value is None for value in window):
            continue
        heading_before = headings[index-2]
        heading_after = headings[index+2]
        angle = (heading_after - heading_before + 540) % 360 - 180
        magnitude = abs(angle)
        if magnitude < 25:
            continue
        distance = haversine_distance(
            cleaned[index-1]["lat"], cleaned[index-1]["lon"],
            cleaned[index+2]["lat"], cleaned[index+2]["lon"],
        )
        if distance < 50:
            continue
        radius = max(10.0, distance / max(math.tan(math.radians(magnitude/2)), 0.03))

        consistency = 0
        for window_index in range(index-1, index+2):
            local_delta = (headings[window_index+1] - headings[window_index] + 540) % 360 - 180
            if local_delta * angle > 0:
                consistency += 1
        if consistency < 2:
            continue

        if radius < 90 and magnitude >= 75:
            classification = "hairpin"
        elif radius < 220 and magnitude >= 45:
            classification = "sharp"
        elif radius < 450 and magnitude >= 30:
            classification = "moderate"
        elif radius < 900:
            classification = "gentle"
        else:
            continue

        confidence = min(
            0.92,
            0.52 + min(magnitude/120, 0.16) + consistency/25 + min(distance/1500, 0.10),
        )
        candidates.append({
            "latitude": cleaned[index]["lat"],
            "longitude": cleaned[index]["lon"],
            "radius_m": round(radius, 1),
            "curve_angle_deg": round(magnitude, 1),
            "direction": "left" if angle < 0 else "right",
            "classification": classification,
            "confidence": round(confidence, 2),
        })

    deduplicated = []
    for candidate in sorted(candidates, key=lambda item: item["latitude"]):
        if any(haversine_distance(candidate["latitude"], candidate["longitude"], item["latitude"], item["longitude"]) < 180 for item in deduplicated):
            continue
        deduplicated.append(candidate)
    return deduplicated


def road_chainage(points, target_lat, target_lon):
    nearest = 0.0
    cumulative = 0.0
    nearest_distance = float("inf")
    for index in range(len(points)-1):
        point1 = points[index]
        point2 = points[index+1]
        segment_distance = haversine_distance(point1["lat"], point1["lon"], point2["lat"], point2["lon"])
        distance_to_point = haversine_distance(
            target_lat, target_lon,
            point1["lat"], point1["lon"],
        )
        if distance_to_point < nearest_distance:
            nearest_distance = distance_to_point
            nearest = cumulative
        cumulative += segment_distance
    return round(nearest, 1)


def write_csv(path, fieldnames, rows):
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    roads = []
    curves = []
    road_features = []
    curve_features = []

    discovered = {}
    for seed in SEED_GHATS:
        anchor = geocode(seed["search"])
        if anchor:
            discovered.setdefault(seed["name"], seed | anchor)

    search_queries = [
        "Ghat road Karnataka",
        "Ghat Karnataka",
        "Western Ghats Karnataka",
        "Kudremukh pass Karnataka",
        "Kodachadri Karnataka",
        "Skandagiri Karnataka",
        "Charmadi Karnataka",
        "Shiradi Karnataka",
        "Agumbe Karnataka",
        "Bisle Karnataka",
        "Hulikal Karnataka",
        "Sampaje Karnataka",
    ]
    for query in search_queries:
        anchor = geocode(query)
        if not anchor:
            continue
        name = anchor["display_name"].split(",")[0]
        discovered.setdefault(name, {
            "name": name,
            "highway": "unclassified/unknown",
            "district": "to verify",
            "search": query,
        } | anchor)

    try:
        named_ways = overpass_named_roads()
    except Exception:
        named_ways = []

    way_ids = set()
    for ghat_name, ghat in discovered.items():
        lat = ghat["latitude"]
        lon = ghat["longitude"]
        ways = overpass_around(lat, lon)
        for way in named_ways:
            if haversine_distance(
                lat, lon,
                sum(point["lat"] for point in way.get("geometry", []) or []) / max(len(way.get("geometry", []) or []), 1),
                sum(point["lon"] for point in way.get("geometry", []) or []) / max(len(way.get("geometry", []) or []), 1),
            ) < 50000:
                ways.append(way)

        for way in ways:
            if way["id"] in way_ids:
                continue
            geometry = way.get("geometry", [])
            if len(geometry) < 3:
                continue
            tags = way.get("tags", {})
            if tags.get("highway") not in (
                "motorway", "trunk", "primary", "secondary", "tertiary",
                "unclassified", "road", "service", "track",
            ):
                continue
            way_ids.add(way["id"])
            points = [{"lat": float(point["lat"]), "lon": float(point["lon"])} for point in geometry]
            chainage_total = sum(
                haversine_distance(
                    points[index]["lat"], points[index]["lon"],
                    points[index+1]["lat"], points[index+1]["lon"],
                )
                for index in range(len(points)-1)
            )
            road_name = tags.get("name") or ghat_name
            highway = tags.get("ref") or ghat.get("highway", "")
            road_rows = {
                "ghat_id": f"KAR-{len(roads)+1:03d}",
                "ghat_road_name": ghat_name,
                "road_name": road_name,
                "district": ghat.get("district", "to verify"),
                "highway_number": highway,
                "osm_way_id": way["id"],
                "road_length_m": round(chainage_total, 1),
                "data_source": "OpenStreetMap Overpass",
                "verification_status": "osm_derived_requires_manual_verification",
            }
            roads.append(road_rows)
            road_features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[point["lon"], point["lat"]] for point in points]},
                "properties": road_rows,
            })

            detected = classify_angle_change(points)
            for sequence, curve in enumerate(detected, start=1):
                chainage = road_chainage(points, curve["latitude"], curve["longitude"])
                curve_id = f"KA-CURVE-{len(curves)+1:06d}"
                row = {
                    "curve_id": curve_id,
                    "ghat_road_name": ghat_name,
                    "road_name": road_name,
                    "district": ghat.get("district", "to verify"),
                    "highway_number": highway,
                    "latitude": curve["latitude"],
                    "longitude": curve["longitude"],
                    "curve_sequence_number": sequence,
                    "curve_direction": curve["direction"],
                    "curve_radius_m": curve["radius_m"],
                    "curve_angle_deg": curve["curve_angle_deg"],
                    "curve_classification": curve["classification"],
                    "road_elevation_m": "",
                    "road_gradient": "",
                    "road_chainage_m": chainage,
                    "blind_curve": "",
                    "reverse_curve": "",
                    "s_bend": "",
                    "dangerous_downhill": "",
                    "dangerous_uphill": "",
                    "data_source": "OpenStreetMap Overpass geometric extraction",
                    "gps_accuracy_m": "",
                    "confidence": curve["confidence"],
                    "verification_status": "estimated_requires_satellite_manual_verification",
                }
                curves.append(row)
                curve_features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [curve["longitude"], curve["latitude"]]},
                    "properties": row,
                })

    road_fieldnames = [
        "ghat_id","ghat_road_name","road_name","district","highway_number","osm_way_id",
        "road_length_m","data_source","verification_status",
    ]
    curve_fieldnames = [
        "curve_id","ghat_road_name","road_name","district","highway_number","latitude","longitude",
        "curve_sequence_number","curve_direction","curve_radius_m","curve_angle_deg","curve_classification",
        "road_elevation_m","road_gradient","road_chainage_m","blind_curve","reverse_curve","s_bend",
        "dangerous_downhill","dangerous_uphill","data_source","gps_accuracy_m","confidence","verification_status",
    ]

    write_csv(DATA_DIR / "karnataka_all_ghat_roads.csv", road_fieldnames, roads)

    hairpins = [row for row in curves if row["curve_classification"] == "hairpin"]
    sharp = [row for row in curves if row["curve_classification"] == "sharp"]
    write_csv(DATA_DIR / "karnataka_all_hairpin_bends.csv", curve_fieldnames, hairpins)
    write_csv(DATA_DIR / "karnataka_all_sharp_curves.csv", curve_fieldnames, sharp)
    write_csv(DATA_DIR / "karnataka_all_road_curves.csv", curve_fieldnames, curves)

    with (DATA_DIR / "karnataka_all_ghat_curves.geojson").open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": curve_features}, handle, ensure_ascii=False)

    with (DATA_DIR / "karnataka_all_ghat_roads.geojson").open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": road_features}, handle, ensure_ascii=False)

    validation = {
        "ghat_roads_identified": len(discovered),
        "road_way_segments_extracted": len(roads),
        "curve_records": len(curves),
        "hairpin_records": len(hairpins),
        "sharp_curve_records": len(sharp),
        "road_names": sorted(set(row["ghat_road_name"] for row in roads)),
        "missing_or_manual_verification": sorted(set(row["ghat_road_name"] for row in roads)),
        "completeness_claim": "not_claimed",
        "limitations": [
            "OSM road geometry is source-dependent and may omit private, under-construction or unmapped ghat sections.",
            "Curve coordinates and radii are estimated automatically and require satellite and field verification.",
            "Elevation, gradient, GPS accuracy, blind/dangerous flags and reverse/S-bend flags are not fabricated and remain NULL when unavailable.",
            "Official accident blackspots require separate MoRTH/NHAI/state PWD/source ingestion.",
        ],
    }
    with (DATA_DIR / "karnataka_all_curves_validation.json").open("w", encoding="utf-8") as handle:
        json.dump(validation, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
