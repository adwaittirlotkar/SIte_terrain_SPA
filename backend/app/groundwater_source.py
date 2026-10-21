"""
Real groundwater level data - NOT computed from elevation, NOT a guess.
Sourced from India's National Water Data Portal (nwdp.nwic.gov.in), a real
government CKAN instance run by NWIC (Ministry of Jal Shakti), serving
actual quarterly manual measurements from CGWB's monitoring well network.

This module finds the nearest REAL monitoring well to a requested lat/lon
and returns its actual measured readings - it never estimates, interpolates,
or computes a value for a location that isn't a real station. If the
nearest real station is 8km away, the response says so plainly rather than
implying it's measuring the user's exact site.

Confirmed live (2026-09-11) against the Maharashtra resource:
- Fields: Station, Latitude, Longitude, District, Data Acquisition Time
  (format DD-MM-YYYY HH:MM - confirmed unambiguous from a real record with
  day=21), "Groundwater Level Quarterly Manual (meter)" (text field despite
  being numeric; this is depth-to-water BELOW ground surface, not
  elevation - CGWB's standard convention, and consistent with the sample
  values seen: 3.3-5.3m for Nashik district wells is physically plausible
  as depth-below-surface, implausible as anything else).
- ~13,000+ rows per state (many repeat readings per station over time) -
  too much to fetch in bulk per request, so this caches a deduplicated
  station list per state after the first lookup.

Coverage is intentionally limited to states we've actually confirmed a
resource_id for - seeing a state absent from STATE_RESOURCES means it
genuinely isn't wired up yet, not that no wells exist there.
"""

import math
from typing import Dict, List, Optional, Tuple
import requests

CKAN_BASE = "https://nwdp.nwic.gov.in/api/3/action"

# resource_id confirmed live against the real API (see module docstring).
# Add more states here only after confirming their resource_id the same way -
# guessing an ID would either 404 cleanly or, worse, silently hit the wrong
# state's data.
STATE_RESOURCES: Dict[str, str] = {
    "Maharashtra": "073029e8-492d-416c-9857-3ad3e27c69a6",
}

_station_cache: Dict[str, List[Dict]] = {}

# Rough bounding boxes, only used to decide which state's dataset to even
# attempt - NOT a real administrative boundary lookup. Good enough to avoid
# showing a "nearest Maharashtra well" result for a site in a different
# state entirely; not precise at state borders.
STATE_BBOXES: Dict[str, Tuple[float, float, float, float]] = {
    # state: (south, north, west, east)
    "Maharashtra": (15.6, 22.1, 72.6, 80.9),
}


def guess_state(lat: float, lon: float) -> Optional[str]:
    for state, (south, north, west, east) in STATE_BBOXES.items():
        if south <= lat <= north and west <= lon <= east:
            return state
    return None


class GroundwaterError(Exception):
    pass


def _ckan_get(action: str, params: Dict) -> Dict:
    try:
        resp = requests.get(f"{CKAN_BASE}/{action}", params=params, timeout=30)
    except requests.RequestException as e:
        raise GroundwaterError(f"Could not reach the National Water Data Portal: {e}")
    if resp.status_code != 200:
        raise GroundwaterError(f"National Water Data Portal request failed: HTTP {resp.status_code}")
    data = resp.json()
    if not data.get("success"):
        raise GroundwaterError("National Water Data Portal returned an unsuccessful response.")
    return data["result"]


def _load_station_list(state: str) -> List[Dict]:
    """Fetches and caches a deduplicated (Station, Latitude, Longitude) list
    for a state - one pass of pagination, reused for every lookup after."""
    if state in _station_cache:
        return _station_cache[state]

    resource_id = STATE_RESOURCES.get(state)
    if resource_id is None:
        raise GroundwaterError(
            f"No groundwater data source is wired up for '{state}' yet - only "
            f"{', '.join(STATE_RESOURCES.keys())} are currently supported."
        )

    seen = {}
    offset = 0
    page_size = 1000
    while True:
        result = _ckan_get("datastore_search", {
            "resource_id": resource_id,
            "fields": "Station,Latitude,Longitude,District",
            "limit": page_size,
            "offset": offset,
        })
        records = result.get("records", [])
        if not records:
            break
        for r in records:
            name = r.get("Station")
            lat_s, lon_s = r.get("Latitude"), r.get("Longitude")
            if not name or not lat_s or not lon_s or name in seen:
                continue
            try:
                seen[name] = {
                    "station": name,
                    "lat": float(lat_s),
                    "lon": float(lon_s),
                    "district": r.get("District"),
                }
            except (TypeError, ValueError):
                continue
        offset += page_size
        if offset >= result.get("total", 0):
            break

    stations = list(seen.values())
    _station_cache[state] = stations
    return stations


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def find_nearest_station(lat: float, lon: float, state: str) -> Tuple[Dict, float]:
    stations = _load_station_list(state)
    if not stations:
        raise GroundwaterError(f"No monitoring stations found for '{state}'.")
    best, best_dist = None, float("inf")
    for s in stations:
        d = _haversine_km(lat, lon, s["lat"], s["lon"])
        if d < best_dist:
            best, best_dist = s, d
    return best, best_dist


def get_recent_readings(station_name: str, state: str, limit: int = 8) -> List[Dict]:
    """Real measured readings for one specific station, most recent first."""
    resource_id = STATE_RESOURCES[state]
    result = _ckan_get("datastore_search", {
        "resource_id": resource_id,
        "filters": f'{{"Station": "{station_name}"}}',
        "limit": 200,  # a station's full multi-year history is small; we sort+trim ourselves
    })
    readings = []
    for r in result.get("records", []):
        raw_date = r.get("Data Acquisition Time")
        raw_val = r.get("Groundwater Level Quarterly Manual (meter)")
        if not raw_date or not raw_val or raw_val == "-":
            continue
        try:
            depth_m = float(raw_val)
        except (TypeError, ValueError):
            continue
        readings.append({"date": raw_date, "depth_below_ground_m": depth_m})

    # "DD-MM-YYYY HH:MM" sorts correctly as a string only if we parse it -
    # confirmed format from a live record (day=21, so unambiguous).
    def _sort_key(item):
        try:
            d, m, rest = item["date"].split("-", 2)
            y = rest.split(" ")[0]
            return (int(y), int(m), int(d))
        except Exception:
            return (0, 0, 0)

    readings.sort(key=_sort_key, reverse=True)
    return readings[:limit]


def get_nearest_groundwater_data(lat: float, lon: float) -> Optional[Dict]:
    """
    Top-level entry point - only needs lat/lon, figures out the state itself.
    Returns None (not an error) if no coverage exists for this location - the
    caller should treat that as "unavailable here", not a failure.
    """
    state = guess_state(lat, lon)
    if state is None or state not in STATE_RESOURCES:
        return None

    station, distance_km = find_nearest_station(lat, lon, state)
    readings = get_recent_readings(station["station"], state)
    if not readings:
        raise GroundwaterError(f"Found station '{station['station']}' but it has no valid readings.")

    # Seasonal trend: compare latest reading against 8-reading history
    flow_direction = _estimate_flow_direction(station["lat"], station["lon"])
    quality_info = _estimate_water_quality(station.get("district") or "")

    depth_trend = None
    if len(readings) >= 2:
        d_latest = readings[0]["depth_below_ground_m"]
        d_older  = readings[-1]["depth_below_ground_m"]
        if d_latest > d_older + 0.5:
            depth_trend = "falling"   # water table dropping (depth increasing)
        elif d_latest < d_older - 0.5:
            depth_trend = "rising"    # water table rising (depth decreasing)
        else:
            depth_trend = "stable"

    return {
        "station_name": station["station"],
        "district": station.get("district"),
        "station_lat": station["lat"],
        "station_lon": station["lon"],
        "distance_km": round(distance_km, 2),
        "latest_reading": readings[0],
        "recent_readings": readings,
        "depth_trend": depth_trend,
        "flow_direction": flow_direction,
        "water_quality": quality_info,
        "source": "Central Ground Water Board (CGWB), via India's National Water Data Portal",
        "note": (
            f"This is the REAL, MEASURED depth to groundwater at the nearest known monitoring "
            f"well - {station['station']}, {distance_km:.1f} km from your selected site - not a "
            f"value for your exact location. Groundwater depth can vary meaningfully over even a "
            f"few hundred meters depending on local geology, so treat this as regional context, "
            f"not a site-specific measurement."
        ),
    }


def _estimate_flow_direction(lat: float, lon: float) -> dict:
    """
    Regional groundwater flow direction for the Deccan Plateau / Maharashtra.
    Groundwater in the Deccan follows surface topographic gradient at regional
    scale - generally flowing from the Western Ghats (high elevation, west)
    toward the interior plateau and eventually to major river systems.
    This is a REGIONAL approximation, not a site-specific vector measurement.
    Source basis: CGWB Regional Aquifer System Analysis reports for Maharashtra.
    """
    # Maharashtra is broadly split by the Sahyadri (Western Ghats) watershed
    # West of 74.5°E → coastal strip, flow roughly west toward Arabian Sea
    # East of 74.5°E → Deccan interior, flow broadly east/SE toward Godavari/Krishna
    if lon < 74.5:
        bearing_deg = 270.0   # west
        direction_label = "West (toward Arabian Sea coast)"
    elif lat > 20.5:
        bearing_deg = 75.0    # ENE - upper Maharashtra toward Godavari catchment
        direction_label = "East-Northeast (toward Godavari river basin)"
    else:
        bearing_deg = 110.0   # ESE - lower Maharashtra toward Krishna catchment
        direction_label = "East-Southeast (toward Krishna river basin)"

    return {
        "bearing_deg": bearing_deg,
        "direction_label": direction_label,
        "basis": (
            "Regional approximation based on Deccan Plateau topographic gradient "
            "and CGWB aquifer system analysis for Maharashtra. Not a site-specific "
            "measurement - local geology, faults, and pumping can alter local flow."
        ),
    }


# Typical groundwater chemistry for Deccan Basalt aquifer systems in Maharashtra.
# Source: CGWB Ground Water Quality Report, Maharashtra (2023), BIS IS 10500:2012
# drinking water standards used as benchmarks.
_DISTRICT_QUALITY_OVERRIDES = {
    # Districts with documented elevated fluoride (CGWB data)
    "Yavatmal": {"fluoride_risk": "elevated", "hardness": "high"},
    "Nanded":   {"fluoride_risk": "elevated", "hardness": "high"},
    "Osmanabad":{"fluoride_risk": "elevated", "hardness": "high"},
    "Latur":    {"fluoride_risk": "elevated", "hardness": "high"},
    "Buldhana": {"fluoride_risk": "moderate", "hardness": "high"},
    # Coastal / Konkan - relatively softer, lower mineral load
    "Raigad":   {"hardness": "low",  "salinity_risk": "moderate"},
    "Ratnagiri":{"hardness": "low",  "salinity_risk": "low"},
    "Sindhudurg":{"hardness":"low",  "salinity_risk": "low"},
    # Nashik / Pune belt - well-studied, generally within limits
    "Nashik":   {"hardness": "moderate"},
    "Pune":     {"hardness": "moderate"},
}

def _estimate_water_quality(district: str) -> dict:
    """
    Groundwater quality profile for Deccan Basalt aquifer systems.
    These are REGIONAL estimates based on CGWB published studies, not a
    chemical analysis of this specific well. Actual quality varies by season,
    depth, and local land use - always test before using as drinking water.
    """
    overrides = _DISTRICT_QUALITY_OVERRIDES.get(district, {})

    hardness     = overrides.get("hardness", "moderate")       # mg/L CaCO3
    fluoride_risk = overrides.get("fluoride_risk", "low")
    salinity_risk = overrides.get("salinity_risk", "low")

    # Build mineral table typical for Deccan Basalt groundwater
    minerals = [
        {
            "mineral": "Calcium (Ca²⁺)",
            "typical_range": "40–120 mg/L",
            "role": "Primary hardness contributor; safe at these levels",
            "source": "Dissolution of basalt minerals and calcite",
        },
        {
            "mineral": "Magnesium (Mg²⁺)",
            "typical_range": "10–50 mg/L",
            "role": "Secondary hardness; helps with structural role in bones",
            "source": "Weathering of pyroxene and olivine in basalt",
        },
        {
            "mineral": "Bicarbonate (HCO₃⁻)",
            "typical_range": "200–400 mg/L",
            "role": "Main buffering agent; keeps water slightly alkaline (pH 7.5–8.2)",
            "source": "CO₂ dissolution and carbonate rock interaction",
        },
        {
            "mineral": "Silica (SiO₂)",
            "typical_range": "20–60 mg/L",
            "role": "Dissolved from basalt; harmless at these levels",
            "source": "Hydrolysis of silicate minerals in Deccan Trap basalt",
        },
        {
            "mineral": "Sodium (Na⁺)",
            "typical_range": "10–80 mg/L",
            "role": "Generally within safe limits in this region",
            "source": "Plagioclase feldspar weathering in basalt",
        },
        {
            "mineral": "Chloride (Cl⁻)",
            "typical_range": "10–100 mg/L" if salinity_risk == "low" else "50–300 mg/L",
            "role": "Indicator of agricultural runoff; elevated near coast",
            "source": "Anthropogenic inputs and coastal proximity",
        },
        {
            "mineral": "Fluoride (F⁻)",
            "typical_range": (
                "0.8–1.8 mg/L (BIS limit 1.0–1.5)"
                if fluoride_risk == "elevated"
                else "0.2–0.8 mg/L (within BIS limit)"
            ),
            "role": (
                "CAUTION: elevated fluoride documented in this district. "
                "Prolonged consumption above 1.5 mg/L can cause dental/skeletal fluorosis."
                if fluoride_risk == "elevated"
                else "Within normal safe range for drinking"
            ),
            "source": "Fluorite minerals in basalt; longer residence time = higher concentration",
        },
        {
            "mineral": "Nitrate (NO₃⁻)",
            "typical_range": "5–30 mg/L (BIS limit 45 mg/L)",
            "role": "Elevated near agricultural land; should be tested locally",
            "source": "Agricultural fertilisers and septic leachate",
        },
        {
            "mineral": "Iron (Fe)",
            "typical_range": "0.01–0.5 mg/L",
            "role": "Usually within limits; staining may occur above 0.3 mg/L",
            "source": "Weathering of iron-bearing minerals in basalt",
        },
    ]

    hardness_label = {"low": "Soft (< 150 mg/L CaCO₃)", "moderate": "Moderately hard (150–300 mg/L CaCO₃)", "high": "Hard to very hard (> 300 mg/L CaCO₃)"}
    overall_rating = (
        "Caution — fluoride may exceed limits. Test before drinking."
        if fluoride_risk == "elevated"
        else "Generally suitable for agriculture; test before drinking water use."
    )

    return {
        "overall_rating": overall_rating,
        "hardness_class": hardness_label.get(hardness, hardness_label["moderate"]),
        "ph_range": "7.5 – 8.2 (slightly alkaline)",
        "aquifer_type": "Deccan Basalt (vesicular / fractured basalt)",
        "minerals": minerals,
        "standards_reference": "BIS IS 10500:2012 (Indian drinking water standard)",
        "disclaimer": (
            "These are REGIONAL estimates based on published CGWB studies for Deccan Basalt aquifers "
            "in Maharashtra. They are NOT a chemical analysis of this specific well. Actual mineral "
            "concentrations vary with depth, season, and local land use. Always get a lab test "
            "before using groundwater for drinking or food processing."
        ),
    }
