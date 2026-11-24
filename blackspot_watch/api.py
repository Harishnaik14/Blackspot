import csv
import io
from datetime import datetime

import pandas as pd
import httpx
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser
from rest_framework.views import APIView
from rest_framework import status

from apps.vehicles.models import Vehicle
from apps.roads.models import RoadSegment
from apps.blackspots.models import Blackspot
from apps.gps_tracking.models import GPSRecord
from apps.curve_analysis.models import Curve
from apps.curve_analysis.geometry import detect_curves, haversine_distance
from apps.speed_prediction.engine import estimate_safe_speed, warning_distance
from apps.blackspots.risk import classify_risk
from apps.alerts.models import Alert


DEMO_ROUTE = [
    {"lat":13.121079,"lon":75.525094},
    {"lat":13.108000,"lon":75.500000},
    {"lat":13.090000,"lon":75.484000},
    {"lat":13.070000,"lon":75.470000},
    {"lat":13.050000,"lon":75.442000},
    {"lat":13.030000,"lon":75.405000},
    {"lat":13.012000,"lon":75.360000},
    {"lat":12.995751,"lon":75.329350},
]

DEMO_CURVES = [
    {"latitude":13.0700,"longitude":75.4700,"radius":62,"direction":"right","severity":"sharp","confidence":0.93,"speed":24},
    {"latitude":13.0500,"longitude":75.4420,"radius":118,"direction":"left","severity":"moderate","confidence":0.88,"speed":38},
    {"latitude":13.0300,"longitude":75.4050,"radius":38,"direction":"right","severity":"sharp","confidence":0.96,"speed":18},
    {"latitude":13.0120,"longitude":75.3600,"radius":205,"direction":"left","severity":"gentle","confidence":0.82,"speed":48},
]

DEMO_BLACKSPOTS = [
    {"latitude":13.0700,"longitude":75.4700,"accident_count":8,"severity":4,"accuracy_percent":72,"source":"Illustrative demo dataset — not verified accident data","verification_status":"illustrative"},
    {"latitude":13.0300,"longitude":75.4050,"accident_count":12,"severity":5,"accuracy_percent":68,"source":"Illustrative demo dataset — not verified accident data","verification_status":"illustrative"},
    {"latitude":13.0120,"longitude":75.3600,"accident_count":3,"severity":2,"accuracy_percent":76,"source":"Illustrative demo dataset — not verified accident data","verification_status":"illustrative"},
]


@api_view(['GET'])
def blackspots(request):
    return Response(DEMO_BLACKSPOTS)


@api_view(['GET'])
def dataset_ghats(request):
    return Response([
        {
            "ghat_id": row.ghat_id,
            "ghat_name": row.ghat_name,
            "state": row.state,
            "district": row.district,
            "highway_number": row.highway_number,
            "latitude": row.latitude,
            "longitude": row.longitude,
            "data_source": row.data_source,
            "verification_status": row.verification_status,
        }
        for row in RoadSegment.objects.exclude(latitude__isnull=True).exclude(longitude__isnull=True)
    ])


@api_view(['GET'])
def dataset_hairpins(request):
    return Response([
        {
            "curve_id": row.curve_id,
            "ghat_name": row.ghat_name,
            "state": row.state,
            "district": row.district,
            "highway_number": row.highway_number,
            "hairpin_number": row.hairpin_number,
            "latitude": row.latitude,
            "longitude": row.longitude,
            "curve_direction": row.direction,
            "radius_m": row.radius,
            "curve_angle_deg": row.curve_angle,
            "curve_type": "hairpin",
            "road_elevation_m": row.elevation,
            "road_gradient": row.gradient,
            "road_width_m": row.road_width,
            "data_source": row.data_source,
            "verification_status": row.verification_status,
            "confidence": row.confidence,
        }
        for row in Curve.objects.filter(severity="hairpin")
    ])


@api_view(['GET'])
def dataset_curves(request):
    return Response([
        {
            "curve_id": row.curve_id,
            "ghat_name": row.ghat_name,
            "state": row.state,
            "district": row.district,
            "highway_number": row.highway_number,
            "latitude": row.latitude,
            "longitude": row.longitude,
            "curve_direction": row.direction,
            "radius_m": row.radius,
            "curve_type": "hairpin" if row.severity == "hairpin" else "curve",
            "severity": row.severity,
            "data_source": row.data_source,
            "verification_status": row.verification_status,
            "confidence": row.confidence,
        }
        for row in Curve.objects.all()
    ])


@api_view(['GET'])
def dataset_accident_blackspots(request):
    return Response([
        {
            "blackspot_id": row.blackspot_id,
            "state": row.state,
            "district": row.district,
            "highway_number": row.highway_number,
            "road_name": row.road_name,
            "latitude": row.latitude,
            "longitude": row.longitude,
            "road_chainage": row.road_chainage,
            "accident_count": row.accident_count,
            "fatalities": row.fatalities,
            "injuries": row.injuries,
            "accident_reporting_period": row.accident_reporting_period,
            "blackspot_severity": row.severity,
            "rectification_status": row.rectification_status,
            "official_source": row.source,
            "verification_status": row.verification_status,
        }
        for row in Blackspot.objects.all()
    ])


@api_view(['GET'])
def geocode(request):
    query = (request.query_params.get("q") or "").strip()
    if len(query) < 3:
        return Response({"results": []})
    try:
        with httpx.Client(timeout=12) as client:
            response = client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "addressdetails": 1, "limit": 8, "countrycodes": "in"},
                headers={"User-Agent": "BlackspotWatch/1.0 (road-safety demonstration)"},
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError):
        return Response({"error": "Place search is temporarily unavailable."}, status=502)
    results = [
        {
            "name": item.get("display_name"),
            "lat": float(item["lat"]),
            "lon": float(item["lon"]),
        }
        for item in payload
        if item.get("lat") and item.get("lon")
    ]
    return Response({"results": results})


@api_view(['GET'])
def routes(request):
    start_lat = request.query_params.get("start_lat")
    start_lon = request.query_params.get("start_lon")
    end_lat = request.query_params.get("end_lat")
    end_lon = request.query_params.get("end_lon")
    if all((start_lat, start_lon, end_lat, end_lon)):
        try:
            float(start_lat), float(start_lon), float(end_lat), float(end_lon)
        except ValueError:
            return Response({"error": "Route coordinates must be numeric."}, status=400)
        start = f"{start_lon},{start_lat}"
        end = f"{end_lon},{end_lat}"
        route_name = "Selected route"
    else:
        start = "75.5250941,13.1210790"
        end = "75.3293505,12.9957513"
        route_name = "Charmadi Ghat · Kottigehara to Ujire"
    try:
        with httpx.Client(timeout=12) as client:
            osrm = client.get(
                f"https://router.project-osrm.org/route/v1/driving/{start};{end}",
                params={"overview": "full", "geometries": "geojson"},
            )
            osrm.raise_for_status()
            geometry = osrm.json()["routes"][0]["geometry"]["coordinates"]
            route_coordinates = [{"lat": lat, "lon": lon} for lon, lat in geometry]
            distance_m = osrm.json()["routes"][0]["distance"]
    except (httpx.HTTPError, KeyError, IndexError, ValueError):
        route_coordinates = DEMO_ROUTE if not all((start_lat, start_lon, end_lat, end_lon)) else []
        distance_m = None

    on_route_demo_blackspots = DEMO_BLACKSPOTS if not all((start_lat, start_lon, end_lat, end_lon)) else []

    curve_points = [{"lat": point["lat"], "lon": point["lon"]} for point in route_coordinates]
    detected_curves = detect_curves(curve_points, noise_distance_m=25)
    detected_curves = [
        curve for curve in detected_curves
        if curve["confidence"] >= 0.58 and abs(curve["radius"]) >= 35
        and curve["severity"] == "hairpin"
    ]
    for curve in detected_curves:
        curve["route_index"] = min(
            range(len(curve_points)),
            key=lambda index: haversine_distance(
                curve["latitude"], curve["longitude"],
                curve_points[index]["lat"], curve_points[index]["lon"],
            ),
        )
    detected_curves = sorted(
        detected_curves,
        key=lambda item: item["route_index"],
    )[:12]
    route_curves = []
    for curve in detected_curves:
        radius = curve["radius"]
        speed = estimate_safe_speed(radius, "car", 0.0, 0.65, 0.0)
        bike_speed = estimate_safe_speed(radius, "bike", 0.0, 0.65, 0.0)
        nearby_accidents = 0
        nearest_blackspot_accuracy = None
        nearest_blackspot_distance = None
        for spot in on_route_demo_blackspots:
            distance = haversine_distance(curve["latitude"], curve["longitude"], spot["latitude"], spot["longitude"])
            if nearest_blackspot_distance is None or distance < nearest_blackspot_distance:
                nearest_blackspot_distance = distance
                nearest_blackspot_accuracy = spot["accuracy_percent"]
                nearby_accidents = spot["accident_count"] if distance < 5000 else 0
        route_curves.append({
            **curve,
            "curve_type": "Hairpin bend",
            "recommended_speed_car_kph": speed,
            "recommended_speed_bike_kph": bike_speed,
            "illustrative_accident_count": nearby_accidents,
            "blackspot_accuracy_percent": nearest_blackspot_accuracy,
            "blackspot_distance_m": round(nearest_blackspot_distance or 0, 1),
            "blackspot_verification": "illustrative" if nearby_accidents else "no-demonstration-data",
        })

    return Response({
        "routes": [
            {
                "id":"charmadi-ghat",
                "name": route_name,
                "vehicle_supported":["car","bike"],
                "coordinates":route_coordinates,
                "distance_m":distance_m,
                "data_source":"OpenStreetMap / OSRM route geometry; illustrative hazard overlays",
                "curves": route_curves,
                "blackspots": on_route_demo_blackspots,
                "verified_accident_count": 0,
                "data_quality": "Verified accident count unavailable. Blackspot entries are illustrative until linked to an approved source.",
            },
            {
                "id":"charmadi-ghat-conservative",
                "name":"Charmadi Ghat · Conservative illustrative route",
                "vehicle_supported":["car","bike"],
                "coordinates":DEMO_ROUTE,
                "distance_m":distance_m,
                "data_source":"Illustrative demo geometry",
                "curves": route_curves,
                "blackspots": on_route_demo_blackspots,
                "verified_accident_count": 0,
                "data_quality":"Verified accident count unavailable. All hazard entries are illustrative.",
            },
        ]
    })


@api_view(['POST'])
def gps(request):
    latitude = request.data.get('latitude')
    longitude = request.data.get('longitude')
    if latitude is None or longitude is None:
        return Response({"error":"latitude and longitude are required."}, status=400)
    try:
        latitude, longitude = float(latitude), float(longitude)
        speed = float(request.data.get('speed')) if request.data.get('speed') not in (None,'') else None
        heading = float(request.data.get('heading')) if request.data.get('heading') not in (None,'') else None
        accuracy = float(request.data.get('accuracy')) if request.data.get('accuracy') not in (None,'') else None
    except (TypeError, ValueError):
        return Response({"error":"GPS values must be numeric."}, status=400)
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return Response({"error":"Coordinates are outside valid WGS84 ranges."}, status=400)
    record = GPSRecord.objects.create(
        latitude=latitude, longitude=longitude, speed=speed, heading=heading,
        accuracy=accuracy, timestamp=timezone.now(),
    )
    return Response({"id":record.id,"recorded":True})


@api_view(['POST'])
def curve_analysis(request):
    points = request.data.get('points', [])
    if not isinstance(points, list) or len(points) < 5:
        return Response({"error":"At least 5 GPS points are required."}, status=400)
    normalized = []
    for point in points:
        try:
            normalized.append({"lat":float(point['latitude']), "lon":float(point['longitude'])})
        except (KeyError, TypeError, ValueError):
            return Response({"error":"Each point requires numeric latitude and longitude."}, status=400)
    curves = detect_curves(normalized)
    return Response({"curves":curves,"point_count":len(normalized),"data_source":"calculated"})


@api_view(['POST'])
def safe_speed(request):
    try:
        radius = float(request.data.get('radius'))
    except (TypeError, ValueError):
        return Response({"error":"radius must be numeric."}, status=400)
    vehicle_type = request.data.get('vehicle_type','car')
    if vehicle_type not in ('car','bike'):
        return Response({"error":"vehicle_type must be car or bike."}, status=400)
    banking = float(request.data.get('banking_ratio') or 0)
    friction = float(request.data.get('friction') or 0.65)
    gradient = float(request.data.get('gradient') or 0)
    speed = estimate_safe_speed(radius, vehicle_type, banking, friction, gradient)
    return Response({
        "recommended_speed_kph":speed,
        "assumptions":{"banking_ratio":banking,"friction":friction,"gradient":gradient,"safety_margin":0.82},
        "uncertainty":"High until road banking, friction and gradient are field-verified.",
        "disclaimer":"Starting estimate only; not a guaranteed safe speed.",
    })


@api_view(['POST'])
def alerts(request):
    try:
        current_speed = float(request.data.get('current_speed',0))
        recommended_speed = float(request.data.get('recommended_speed',0))
        distance = float(request.data.get('distance',0))
        radius = float(request.data.get('radius',0))
    except (TypeError, ValueError):
        return Response({"error":"current_speed, recommended_speed, distance and radius must be numeric."}, status=400)
    distance_warning = warning_distance(current_speed, recommended_speed)
    should_warn = 0 <= distance <= distance_warning and radius > 0
    risk = classify_risk('sharp' if radius < 80 else 'moderate' if radius < 180 else 'gentle',
                         8 if radius < 80 else 3, distance)
    if should_warn:
        Alert.objects.create(hazard="Upcoming curve",
                             recommended_speed=recommended_speed,
                             current_speed=current_speed,
                             distance=distance,
                             risk_level=risk)
    return Response({"should_warn":should_warn,"warning_distance_m":distance_warning,"risk_level":risk,
                     "message":f"Warning. Approaching a curve. Distance {round(distance)} metres. Recommended approach speed {round(recommended_speed)} kilometres per hour." if should_warn else "No warning at this distance."})


class GPSUploadView(APIView):
    def post(self, request):
        uploaded = request.data.get('file')
        if not uploaded:
            return Response({"error":"CSV file is required."}, status=400)
        try:
            frame = pd.read_csv(uploaded)
        except (csv.Error, pd.errors.ParserError, UnicodeDecodeError, ValueError) as error:
            return Response({"error":f"Could not parse CSV: {error}"}, status=400)
        columns = {str(column).strip().lower(): column for column in frame.columns}
        required = {'latitude','longitude','timestamp'}
        missing = required - set(columns)
        if missing:
            return Response({"error":f"Missing required columns: {', '.join(sorted(missing))}"}, status=400)
        lat = pd.to_numeric(frame[columns['latitude']], errors='coerce')
        lon = pd.to_numeric(frame[columns['longitude']], errors='coerce')
        timestamps = pd.to_datetime(frame[columns['timestamp']], errors='coerce', utc=True)
        speed_column = columns.get('speed') or columns.get('vehicle_speed')
        speed = pd.to_numeric(frame[speed_column], errors='coerce') if speed_column else None
        valid_mask = lat.between(-90,90) & lon.between(-180,180) & timestamps.notna()
        valid_mask = valid_mask.fillna(False)
        seen = set()
        duplicates = 0
        uploaded_count = 0
        for index in frame.index:
            if not bool(valid_mask.loc[index]):
                continue
            point_key = (round(float(lat.loc[index]), 6), round(float(lon.loc[index]), 6))
            if point_key in seen:
                duplicates += 1
                continue
            seen.add(point_key)
            GPSRecord.objects.create(
                latitude=float(lat.loc[index]),
                longitude=float(lon.loc[index]),
                speed=float(speed.loc[index]) if speed is not None and pd.notna(speed.loc[index]) else None,
                timestamp=timestamps.loc[index].to_pydatetime(),
            )
            uploaded_count += 1
        return Response({
            "uploaded":uploaded_count,
            "invalid_rows":int(len(frame)-uploaded_count-duplicates),
            "duplicates":duplicates,
            "preview":frame.loc[valid_mask].head(8).fillna('').to_dict('records'),
            "columns":list(frame.columns),
        })


class BlackspotUploadView(APIView):
    def post(self, request):
        uploaded = request.data.get('file')
        if not uploaded:
            return Response({"error":"CSV file is required."}, status=400)
        try:
            frame = pd.read_csv(uploaded)
        except (csv.Error, pd.errors.ParserError, UnicodeDecodeError, ValueError) as error:
            return Response({"error":f"Could not parse CSV: {error}"}, status=400)
        columns = {str(column).strip().lower(): column for column in frame.columns}
        accident_column = columns.get('accident_count') or columns.get('accidents')
        required = {'latitude','longitude'}
        missing = required - set(columns)
        if accident_column is None:
            missing.add('accident_count')
        if missing:
            return Response({"error":f"Missing required columns: {', '.join(sorted(missing))}"}, status=400)
        lat = pd.to_numeric(frame[columns['latitude']], errors='coerce')
        lon = pd.to_numeric(frame[columns['longitude']], errors='coerce')
        accidents = pd.to_numeric(frame[accident_column], errors='coerce')
        fatalities = pd.to_numeric(frame[columns['fatalities']], errors='coerce') if 'fatalities' in columns else None
        valid_mask = lat.between(-90,90) & lon.between(-180,180) & accidents.ge(0)
        seen = set()
        duplicates = 0
        uploaded_count = 0
        for index in frame.index:
            if not bool(valid_mask.loc[index]):
                continue
            point_key = (round(float(lat.loc[index]), 6), round(float(lon.loc[index]), 6))
            if point_key in seen:
                duplicates += 1
                continue
            seen.add(point_key)
            source = str(frame.loc[index, columns['source']]) if 'source' in columns else 'User-uploaded accident database'
            verification = str(frame.loc[index, columns['verification_status']]) if 'verification_status' in columns else 'unverified'
            Blackspot.objects.create(
                latitude=float(lat.loc[index]),
                longitude=float(lon.loc[index]),
                accident_count=int(accidents.loc[index]),
                fatalities=int(fatalities.loc[index]) if fatalities is not None and pd.notna(fatalities.loc[index]) else None,
                source=source,
                verification_status=verification,
            )
            uploaded_count += 1
        return Response({
            "uploaded":uploaded_count,
            "invalid_rows":int(len(frame)-uploaded_count-duplicates),
            "duplicates":duplicates,
            "preview":frame.loc[valid_mask].head(8).fillna('').to_dict('records'),
            "columns":list(frame.columns),
        })


class CurveUploadView(APIView):
    def post(self, request):
        uploaded = request.data.get('file')
        if not uploaded:
            return Response({"error":"CSV file is required."}, status=400)
        try:
            frame = pd.read_csv(uploaded)
        except (csv.Error, pd.errors.ParserError, UnicodeDecodeError, ValueError) as error:
            return Response({"error":f"Could not parse CSV: {error}"}, status=400)
        columns = {str(column).strip().lower(): column for column in frame.columns}
        required_names = {'latitude','longitude','radius','direction','curve_type','severity'}
        aliases = {
            'radius': ('radius','radius_m','curve_radius_m'),
            'direction': ('direction','curve_direction'),
            'curve_type': ('curve_type','classification'),
            'severity': ('severity','curve_classification'),
        }
        resolved = {}
        for name in ('latitude','longitude'):
            resolved[name] = columns.get(name)
        for name, choices in aliases.items():
            resolved[name] = next((columns[choice] for choice in choices if choice in columns), None)
        missing = [name for name in required_names if resolved.get(name) is None]
        if missing:
            return Response({"error":f"Missing required columns: {', '.join(sorted(missing))}"}, status=400)

        lat = pd.to_numeric(frame[resolved['latitude']], errors='coerce')
        lon = pd.to_numeric(frame[resolved['longitude']], errors='coerce')
        radius = pd.to_numeric(frame[resolved['radius']], errors='coerce')
        valid_mask = lat.between(-90,90) & lon.between(-180,180) & radius.gt(0)
        seen = set()
        duplicates = 0
        uploaded_count = 0
        confidence_column = columns.get('confidence')
        source_column = columns.get('data_source') or columns.get('source')
        verification_column = columns.get('verification_status')
        for index in frame.index:
            if not bool(valid_mask.loc[index]):
                continue
            point_key = (round(float(lat.loc[index]), 6), round(float(lon.loc[index]), 6))
            if point_key in seen:
                duplicates += 1
                continue
            seen.add(point_key)
            direction = str(frame.loc[index, resolved['direction']]).strip().lower()
            if direction not in ('left','right','unknown'):
                continue
            confidence = 0.7
            if confidence_column:
                try:
                    confidence = max(0.0, min(1.0, float(frame.loc[index, confidence_column])))
                except (TypeError, ValueError):
                    confidence = 0.7
            Curve.objects.create(
                latitude=float(lat.loc[index]),
                longitude=float(lon.loc[index]),
                radius=float(radius.loc[index]),
                direction=direction,
                severity=str(frame.loc[index, resolved['severity']]).strip().lower(),
                confidence=confidence,
                data_source=str(frame.loc[index, source_column]) if source_column else 'User-uploaded curve database',
                verification_status=str(frame.loc[index, verification_column]) if verification_column else 'unverified',
            )
            uploaded_count += 1
        return Response({
            "uploaded":uploaded_count,
            "invalid_rows":int(len(frame)-uploaded_count-duplicates),
            "duplicates":duplicates,
            "preview":frame.loc[valid_mask].head(8).fillna('').to_dict('records'),
            "columns":list(frame.columns),
        })


@api_view(['GET'])
def analytics(request):
    gps_records = GPSRecord.objects.exclude(speed__isnull=True).order_by("-timestamp")[:50]
    actual_speeds = [record.speed for record in gps_records]
    if actual_speeds:
        average_actual = round(sum(actual_speeds)/len(actual_speeds), 1)
        recommended_reference = 42.0
        gps_driving_accuracy = max(0.0, min(100.0, 100.0 - abs(average_actual-recommended_reference)/max(recommended_reference,1)*100))
    else:
        average_actual = None
        gps_driving_accuracy = None
    return Response({
        "total_blackspots":len(DEMO_BLACKSPOTS),
        "sharp_curves":sum(curve["severity"]=="sharp" for curve in DEMO_CURVES),
        "high_risk_locations":sum(curve["severity"]=="sharp" for curve in DEMO_CURVES),
        "curve_radius_distribution":[{"range":"Under 75 m","count":2},{"range":"75–150 m","count":1},{"range":"Over 150 m","count":1}],
        "risk_distribution":[{"risk":"Critical","count":1},{"risk":"High","count":1},{"risk":"Medium","count":1},{"risk":"Low","count":1}],
        "speed_comparison":[{"curve":f"Curve {index+1}","current":min(55,speed+18),"recommended":min(55,speed)} for index,speed in enumerate([24,38,18,48])],
        "accidents_represented":sum(spot["accident_count"] for spot in DEMO_BLACKSPOTS),
        "gps_samples":len(actual_speeds),
        "average_actual_speed_kph":average_actual,
        "gps_driving_accuracy_percent":round(gps_driving_accuracy,1) if gps_driving_accuracy is not None else None,
        "data_source":"Illustrative demonstration data",
    })
