# India Ghat Dataset

## Status

This directory contains source-aware initial datasets for eight Indian Ghat locations.
It deliberately contains no invented accident counts, fatalities or official blackspots.

## Files

- `india_ghat_roads.csv`
- `india_hairpin_curves.csv`
- `india_accident_blackspots.csv`
- `india_road_hazards.csv`
- `india_ghat_roads.geojson`
- `india_hairpin_curves.geojson`
- `india_accident_blackspots.geojson`

## Source and verification rules

- Ghat anchors are geocoded from OpenStreetMap Nominatim.
- Road geometry and candidate hairpins are extracted from OpenStreetMap Overpass road ways.
- Candidate curve radius and severity are estimated by Python geometric analysis.
- Candidate records remain `estimated_unverified` until satellite, engineering or official verification.
- The accident blackspot CSV and GeoJSON contain no rows because no official source data was supplied or independently verified.
- Official accident, fatality and reporting-period fields remain NULL by default.

## Import

```powershell
cd backend
.venv312\Scripts\python.exe manage.py import_india_ghat_data --data-dir ..\data
```
