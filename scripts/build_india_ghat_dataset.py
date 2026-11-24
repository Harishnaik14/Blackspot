import csv
import json
import math
import sys
from pathlib import Path

import httpx

BASE_DIR = Path(__file__).resolve().parents[2]
OUTPUT_DIR = BASE_DIR / "data"
CURVE_ENGINE_DIR = BASE_DIR / "backend"
sys.path.insert(0, str(CURVE_ENGINE_DIR))

from apps.curve_analysis.geometry import detect_curves


GHATS = [
    {"ghat_id": "IN-KA-AGUMBE", "ghat_name": "Agumbe Ghat", "state": "Karnataka", "district": "Shimoga", "highway_number": "NH-169A", "search": "Agumbe Karnataka"},
    {"ghat_id": "IN-KA-CHARMADI", "ghat_name": "Charmadi Ghat", "state": "Karnataka", "district": "Dakshina Kannada", "highway_number": "NH-73", "search": "Charmadi Karnataka"},
    {"ghat_id": "IN-KA-SHIRADI", "ghat_name": "Shiradi Ghat", "state": "Karnataka", "district": "Dakshina Kannada", "highway_number": "NH-75", "search": "Shiradi Karnataka"},
    {"ghat_id": "IN-KA-SAMPAJE", "ghat_name": "Sampaje Ghat", "state": "Karnataka", "district": "Dakshina Kannada", "highway_number": "NH-275", "search": "Sampaje Karnataka"},
    {"ghat_id": "IN-TN-DHIMBAM", "ghat_name": "Dhimbam Ghat", "state": "Tamil Nadu", "district": "Erode", "highway_number": "NH-948", "search": "Dhimbam Tamil Nadu"},
    {"ghat_id": "IN-TN-KOLLI", "ghat_name": "Kolli Hills Ghat Road", "state": "Tamil Nadu", "district": "Namakkal", "highway_number": "", "search": "Kolli Hills Namakkal Tamil Nadu"},
    {"ghat_id": "IN-TN-VALPARAI", "ghat_name": "Valparai Ghat Road", "state": "Tamil Nadu", "district": "Coimbatore", "highway_number": "", "search": "Valparai Coimbatore Tamil Nadu"},
    {"ghat_id": "IN-KL-THAMARASSERY", "ghat_name": "Thamarassery Churam", "state": "Kerala", "district": "Kozhikode", "highway_number": "NH-766", "search": "Thamarassery Kozhikode Kerala"},
]


def geocode_place(query):
    with httpx.Client(timeout=20, headers={"User-Agent": "BlackspotWatchDataBuilder/1.0"}) as client:
        response = client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 5, "countrycodes": "in"},
        )
        response.raise_for_status()
        for item in response.json():
            lat = item.get("lat")
            lon = item.get("lon")
            if lat is not None and lon is not None:
                return float(lat), float(lon), item["display_name"], item.get("osm_id"), item.get("osm_type")
    return None


def overpass_ways(lat, lon, radius_m=25000):
    query = f"""
[out:json][timeout:60];
(
  way["highway"](around:{radius_m},{lat},{lon});
);
out geom tags;
"""
    with httpx.Client(timeout=90, headers={"User-Agent": "BlackspotWatchDataBuilder/1.0"}) as client:
        response = client.post("https://overpass-api.de/api/interpreter", data=query)
        if response.status_code != 200:
            return []
        payload = response.json()
    return payload.get("elements", [])


def haversine(lat1, lon1, lat2, lon2):
    radius = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    value = math.sin(dlat/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlon/2)**2
    return 2 * radius * math.atan2(math.sqrt(value), math.sqrt(max(0, 1-value)))


def write_csv(path, fieldnames, rows):
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    road_rows = []
    curve_rows = []
    hazard_rows = []
    road_features = []
    curve_features = []

    for ghat in GHATS:
        geocode = geocode_place(ghat["search"])
        if geocode is None:
            road_rows.append({
                **ghat,
                "latitude": "",
                "longitude": "",
                "anchor_name": "",
                "osm_id": "",
                "osm_type": "",
                "road_geometry_status": "not_geocoded",
                "elevation": "",
                "gradient": "",
                "road_width": "",
                "data_source": "OpenStreetMap Nominatim",
                "verification_status": "pending",
            })
            continue

        lat, lon, anchor_name, osm_id, osm_type = geocode
        road_rows.append({
            **ghat,
            "latitude": lat,
            "longitude": lon,
            "anchor_name": anchor_name,
            "osm_id": osm_id or "",
            "osm_type": osm_type or "",
            "road_geometry_status": "anchor_only",
            "elevation": "",
            "gradient": "",
            "road_width": "",
            "data_source": "OpenStreetMap Nominatim",
            "verification_status": "OSM-derived anchor",
        })

        ways = overpass_ways(lat, lon)
        road_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "ghat_id": ghat["ghat_id"],
                "ghat_name": ghat["ghat_name"],
                "state": ghat["state"],
                "highway_number": ghat["highway_number"],
                "feature_type": "ghat_anchor",
                "verification_status": "OSM-derived anchor",
                "source": "OpenStreetMap Nominatim",
            },
        })

        accepted_for_ghat = []
        for way in ways:
            geometry = way.get("geometry", [])
            if len(geometry) < 4:
                continue
            coordinates = [[float(point["lon"]), float(point["lat"])] for point in geometry]
            road_features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coordinates},
                "properties": {
                    "ghat_id": ghat["ghat_id"],
                    "ghat_name": ghat["ghat_name"],
                    "state": ghat["state"],
                    "highway_number": ghat["highway_number"],
                    "osm_way_id": way["id"],
                    "road_name": way.get("tags", {}).get("name"),
                    "feature_type": "road_geometry",
                    "verification_status": "OSM-derived",
                    "source": "OpenStreetMap Overpass",
                },
            })

            points = [{"lat": point["lat"], "lon": point["lon"]} for point in geometry]
            detected = detect_curves(points, minimum_segment_m=120, noise_distance_m=60)
            for curve in detected:
                if curve["severity"] != "hairpin":
                    continue
                if curve["radius"] > 75 or curve["confidence"] < 0.82:
                    continue
                duplicate = any(haversine(curve["latitude"], curve["longitude"], item["latitude"], item["longitude"]) < 2500 for item in accepted_for_ghat)
                if duplicate:
                    continue
                accepted_for_ghat.append(curve)
            for index, curve in enumerate(accepted_for_ghat, start=1):
                curve_id = f"{ghat['ghat_id']}-HB-{len(curve_rows)+1:03d}"
                row = {
                    "curve_id": curve_id,
                    "ghat_road_name": ghat["ghat_name"],
                    "state": ghat["state"],
                    "district": ghat["district"],
                    "highway_number": ghat["highway_number"],
                    "hairpin_bend_number": len(curve_rows)+1,
                    "latitude": curve["latitude"],
                    "longitude": curve["longitude"],
                    "curve_direction": curve["direction"],
                    "curve_radius_m": curve["radius"],
                    "curve_angle_deg": "",
                    "curve_type": "hairpin",
                    "road_elevation_m": "",
                    "road_gradient": "",
                    "road_width_m": way.get("tags", {}).get("width", ""),
                    "data_source": "OpenStreetMap Overpass + geometric extraction",
                    "verification_status": "estimated_unverified",
                    "confidence": curve["confidence"],
                }
                curve_rows.append(row)
                curve_features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [curve["longitude"], curve["latitude"]]},
                    "properties": {key: value for key, value in row.items()},
                })

    deduplicated_curves = []
    by_ghat = {}
    for row in curve_rows:
        kept = by_ghat.setdefault(row["ghat_road_name"], [])
        if any(haversine(float(row["latitude"]), float(row["longitude"]), float(item["latitude"]), float(item["longitude"])) < 3000 for item in kept):
            continue
        kept.append(row)
        deduplicated_curves.append(row)
    curve_rows = deduplicated_curves
    for index, row in enumerate(curve_rows, start=1):
        row["hairpin_bend_number"] = index
    curve_features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [float(row["longitude"]), float(row["latitude"])]},
        "properties": {key: value for key, value in row.items()},
    } for row in curve_rows]

    write_csv(
        OUTPUT_DIR / "india_ghat_roads.csv",
        ["ghat_id","ghat_name","state","district","highway_number","search","latitude","longitude","anchor_name","osm_id","osm_type","road_geometry_status","elevation","gradient","road_width","data_source","verification_status"],
        road_rows,
    )
    write_csv(
        OUTPUT_DIR / "india_hairpin_curves.csv",
        ["curve_id","ghat_road_name","state","district","highway_number","hairpin_bend_number","latitude","longitude","curve_direction","curve_radius_m","curve_angle_deg","curve_type","road_elevation_m","road_gradient","road_width_m","data_source","verification_status","confidence"],
        curve_rows,
    )
    write_csv(
        OUTPUT_DIR / "india_accident_blackspots.csv",
        ["blackspot_id","state","district","highway_number","road_name","latitude","longitude","road_chainage","accident_count","fatalities","injuries","accident_reporting_period","blackspot_severity","rectification_status","official_source","verification_status"],
        [],
    )
    write_csv(
        OUTPUT_DIR / "india_road_hazards.csv",
        ["hazard_id","ghat_road_name","state","district","highway_number","hazard_type","latitude","longitude","description","data_source","verification_status"],
        hazard_rows,
    )

    with (OUTPUT_DIR / "india_ghat_roads.geojson").open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": road_features}, handle, ensure_ascii=False)
    with (OUTPUT_DIR / "india_hairpin_curves.geojson").open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": curve_features}, handle, ensure_ascii=False)
    with (OUTPUT_DIR / "india_accident_blackspots.geojson").open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": []}, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
