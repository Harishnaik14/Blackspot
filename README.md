Blackspot Watch
3D Ghat-Road Risk Awareness and Curve Warning Demonstration

Blackspot Watch is a web-based road-safety demonstration for ghat and hilly-road travel. It combines road-route geometry, candidate curve information, GPS location, estimated curve approach speeds and spoken warnings to help a driver become aware of upcoming road geometry.
Safety and data notice: This is a prototype, not a certified navigation or vehicle-safety product. Candidate curves and calculated approach speeds require field/engineering validation. The bundled official accident-blackspot dataset is empty because verified official records were not supplied. Some hard-coded map overlays are explicitly illustrative and must not be presented as real accident history.

1. Main features in the current source
- Route search using start and destination place names.
- Route geometry retrieval from OSRM.
- Map display using MapLibre GL JS with OpenStreetMap raster tiles.
- Candidate ghat/hairpin dataset exposed through the backend.
- Geometric curve detection from ordered route coordinates.
- Estimated approach-speed calculation for cars and bikes.
- Braking/reaction-distance warning calculation.
- Browser GPS/geolocation controls on the driving map.
- Browser speech synthesis for spoken alerts.
- CSV upload endpoints for GPS traces and blackspot records.
- Django REST API and database models for roads, curves, blackspots, GPS, vehicles, alerts and analytics.
The driving screen imports Three.js, but the map itself is rendered by MapLibre GL JS. Verify the actual scene implementation in frontend/assets/js/driving.js before describing the project as a fully modelled 3D vehicle simulation. Map pitch/terrain-style perspective is not the same as a fully 3D road model.

2. Technology stack
Layer	Technology in repository
Frontend	HTML, CSS, JavaScript
Map	MapLibre GL JS
3D library dependency	Three.js (imported by driving.js)
Backend	Python, Django 5.2.7
API	Django REST Framework
Database	SQLite by default; PostgreSQL URL configuration supported
Data processing	Python, NumPy, Pandas
HTTP/API calls	httpx
Route engine	OSRM public routing service
Place search/geocoding	OpenStreetMap Nominatim
Road/curve source pipeline	OpenStreetMap Overpass API
Map tiles	OpenStreetMap raster tile service
Live location	Browser Geolocation API / MapLibre GeolocateControl
Voice	Web Speech API SpeechSynthesis


3. Repository structure
project/
  frontend/
    index.html
    route.html
    driving.html
    analytics.html
    data.html
    assets/css/
    assets/js/
  backend/
    manage.py
    requirements.txt
    blackspot_watch/
      settings.py
      urls.py
      api.py
    apps/
      roads/
      curve_analysis/
      blackspots/
      gps_tracking/
      speed_prediction/
      alerts/
      vehicles/
      analytics/
    scripts/
      build_karnataka_all_curves.py
  data/
    india_ghat_roads.csv
    india_hairpin_curves.csv
    india_accident_blackspots.csv
    india_road_hazards.csv
    corresponding GeoJSON files

4. Local setup
Requirements
- Windows, macOS or Linux
- Python 3.12 recommended for the supplied .venv312 environment
- Internet connection for Nominatim, OSRM, map tiles and Overpass-based data extraction
Backend (Windows PowerShell)
From the project directory:
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 127.0.0.1:8000
If you use the environment already bundled with the project, the original README's commands are:
cd backend
.venv312\Scripts\python.exe -m pip install -r requirements.txt
.venv312\Scripts\python.exe manage.py migrate
.venv312\Scripts\python.exe manage.py runserver 127.0.0.1:8000
Frontend
Open a second terminal from the project directory:
cd frontend
python -m http.server 5500
Open:
http://127.0.0.1:5500
The frontend API base defaults to http://127.0.0.1:8000 in frontend/assets/js/api.js. If the backend is hosted elsewhere, set window.BLACKSPOT_API_URL before loading the frontend scripts and configure Django CORS for the frontend origin.

5. Import the bundled datasets
From project/backend:
python manage.py import_india_ghat_data --data-dir ..\data
The data README identifies the ghat anchor coordinates as Nominatim-derived and candidate road curves as Overpass/geometric-extraction-derived. Candidate curves remain estimated_unverified.
Dataset status found in the uploaded repository
- india_ghat_roads.csv: 8 data rows (ghat anchor records).
- india_hairpin_curves.csv: 338 data rows (candidate hairpin records).
- india_accident_blackspots.csv: header only; 0 official blackspot records.
- The API contains 3 hard-coded illustrative blackspot overlays for the default demonstration route. They are not verified accident records.
- The API's default route fallback is labelled Charmadi Ghat, Kottigehara to Ujire. A user-selected route is requested from OSRM when route coordinates are supplied.
Do not treat the 338 candidate hairpin records as 338 field-verified bends. Inspect their coordinates and map-match them to the correct road before relying on them.

6. External services and dataset references
- OpenStreetMap data: https://www.openstreetmap.org/
- Overpass API: https://overpass-api.de/
- Overpass Turbo (query exploration): https://overpass-turbo.eu/
- Nominatim search API: https://nominatim.org/release-docs/latest/api/Search/
- OSRM API: https://project-osrm.org/docs/v5.24.0/api/
- MapLibre GL JS: https://maplibre.org/maplibre-gl-js/docs/
- Three.js: https://threejs.org/docs/
- Django: https://docs.djangoproject.com/en/5.2/
- Django REST Framework: https://www.django-rest-framework.org/
- Browser Geolocation API: https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API
- Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
- OpenStreetMap tile usage policy: https://operations.osmfoundation.org/policies/tiles/
Respect the usage policies and attribution requirements of each public service. Public demo endpoints are rate-limited and are not guaranteed production infrastructure. For production, use a suitable hosted routing/geocoding provider or operate your own services.

7. API endpoints implemented in the Django URL configuration
Endpoint	Method	Purpose
/api/blackspots/	GET	Returns the demo blackspot overlay
/api/dataset/ghats/	GET	Returns imported ghat anchor records
/api/dataset/hairpins/	GET	Returns stored curve records classified as hairpins
/api/dataset/blackspots/	GET	Returns database blackspot records
/api/geocode/?q=	GET	Place search through Nominatim
/api/routes/	GET	Requests route geometry from OSRM; supports start/end coordinates
/api/gps/	POST	Validates and stores a GPS position
/api/curve-analysis/	POST	Analyses supplied route points
/api/safe-speed/	POST	Calculates an estimated approach speed
/api/alerts/	GET/POST as defined in API	Alert data/actions
/api/upload-gps/	POST	Uploads a GPS CSV
/api/upload-blackspots/	POST	Uploads a blackspot CSV
/api/analytics/	GET	Analytics response


Check backend/blackspot_watch/api.py and backend/blackspot_watch/urls.py for exact request fields and response shapes before integrating another client.

8. What the code calculates
Curve geometry
backend/apps/curve_analysis/geometry.py:
- Removes nearby consecutive points based on a configurable noise-distance threshold.
- Projects latitude/longitude into a local planar coordinate system.
- Calculates headings and heading change over a small point window.
- Estimates a radius and direction.
- Applies geometric thresholds and a consistency check.
- Deduplicates candidates.
The current detector is a heuristic, not a trained AI/ML model. It has restrictive thresholds and a 900 m deduplication rule in the current source; these can suppress nearby bends and should be reviewed before claiming accurate bend inventory.
Estimated speed
backend/apps/speed_prediction/engine.py uses a lateral-acceleration-style relationship with friction, banking, gradient effect, vehicle multiplier and safety margin. It also calculates a warning distance using reaction distance, braking distance and an added margin.

These are engineering-inspired estimates with assumed inputs, not a validated vehicle dynamics model. They are not certified safe speeds.

9. Data upload notes
The current Data page wires CSV uploads for GPS and blackspot files. It does not currently expose a hairpin-curve CSV upload control in frontend/assets/js/data.js. The backend's current import command is the path used to import the bundled ghat and hairpin datasets into the database.

Use the expected CSV columns and inspect API validation before uploading. Do not add made-up accident counts or label estimated coordinates as official.

10. Known limitations to disclose in a demo
1. Official accident blackspot data is not present in the bundled CSV (zero rows).
2. The default route fallback and several overlays are illustrative demo data.
3. Candidate hairpins are OSM-derived geometric estimates and need road-level verification.
4. Current route API detects curves from route geometry using a heuristic and filters to hairpins; the code truncates this detected list to 12.
5. The route preview also fetches stored hairpins and selects records within an 8 km proximity check, capped at 40; this is not strict road/direction map matching and can place markers from nearby roads.
6. The uploaded repository does not establish measured detection accuracy, field validation, accident reduction or production reliability.
7. Public OSM, Nominatim and OSRM endpoints can be rate-limited or unavailable.
8. Browser geolocation requires user permission and a secure context (HTTPS) in deployed environments.
11. Text-format project result summary
Project output: A browser-based prototype that can display a selected road route, show stored candidate hairpin markers, request live browser location, calculate estimated curve approach speeds, calculate a warning distance, and speak warning messages using browser speech synthesis.

Dataset result: The repository contains eight ghat anchor records and 338 OSM/geometric candidate hairpin records. The official accident-blackspot CSV is empty. Three hard-coded illustrative blackspot overlays are used on the default demo route and must be clearly labelled illustrative.

AI/API responsibility: External APIs provide place search, road routing, map tiles and source road data. The application code performs curve-geometry calculations, estimated speed and warning-distance calculations, data validation/storage, route display and warning logic. No trained machine-learning model is demonstrated in the inspected source.

Evaluation result: Unit tests are present for straight-road rejection, a sharp-turn detection case, positive speed/warning outputs, risk classification and API validation. The documentation does not claim that the full suite has been run or that the detector has a measured accuracy score. Run the tests before submission and report the actual output.

Safety conclusion: Blackspot Watch is a decision-support prototype for awareness and demonstration. It must not replace road signs, official navigation, driver judgement or certified vehicle safety systems.