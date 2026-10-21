"""
Real building footprints and roads for a location, from OpenStreetMap's
Overpass API - free, public, no account or key needed. This is what powers
"Place" mode: draping actual buildings/roads on top of the terrain you
already fetched, rather than just showing bare ground.

Scope, stated honestly:
- Buildings come from simple closed `way` geometries only (v1). Complex
  buildings modeled as multipolygon `relation`s (an outer ring plus one or
  more inner "hole" rings - common for buildings with courtyards) are
  skipped, not approximated - counted and reported in `warnings` instead of
  silently drawing something wrong.
- Height comes from the OSM `height` tag when present (real, surveyed-ish
  data), estimated from `building:levels` * 3m/level when only that's
  present (labeled ESTIMATED, not treated as equally trustworthy), or a
  flat default (also labeled ESTIMATED) when neither tag exists.
- Every building/road point gets its elevation from the *already-fetched*
  terrain (nearest real terrain vertex - see `_ElevationSampler`), not
  from OSM (which doesn't carry elevation at all) - so buildings/roads
  correctly sit on the actual terrain shape, not at a flat 0.
"""

import math
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests
from scipy.spatial import cKDTree

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_FALLBACK_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
# Overpass's own usage policy asks clients to identify themselves - a generic
# User-Agent (requests' default) gets a 406 Not Acceptable from some instances.
REQUEST_HEADERS = {"User-Agent": "spa-site-intelligence/0.1 (small-site terrain visualization tool)"}
METERS_PER_LEVEL = 3.0  # standard rough assumption for estimating height from floor count
DEFAULT_BUILDING_HEIGHT = 6.0  # ~2 storeys, used only when OSM has no height/levels tag at all
MAX_BUILDINGS = 500
MAX_ROADS = 300


class OsmFetchError(Exception):
    pass


class _ElevationSampler:
    """Nearest-vertex elevation lookup against the terrain we already built,
    so buildings/roads sit on the real terrain surface rather than at z=0."""

    def __init__(self, terrain_vertices: List[List[float]]):
        xy = np.array([[v[0], v[1]] for v in terrain_vertices])
        self._z = np.array([v[2] for v in terrain_vertices])
        self._tree = cKDTree(xy)

    def sample(self, x: float, y: float) -> float:
        _, idx = self._tree.query([x, y])
        return float(self._z[idx])


def _to_local_xy(lat: float, lon: float, origin: Tuple[float, float]) -> Tuple[float, float]:
    """Same equirectangular approximation as elevation_source.to_local_points,
    duplicated in miniature here rather than importing it, to keep this
    module's only real dependency on the rest of the app being the terrain
    vertices it's handed - not a hidden coupling to elevation_source's
    internals."""
    lat0, lon0 = origin
    lat0_rad = math.radians(lat0)
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = 111_320.0 * math.cos(lat0_rad)
    return (lon - lon0) * meters_per_deg_lon, (lat - lat0) * meters_per_deg_lat


def _parse_height(tags: Dict[str, str]) -> Tuple[float, str]:
    """Returns (height_meters, source) where source is 'OSM_TAG' (trust it)
    or 'ESTIMATED' (don't - it's a guess, and the frontend should say so)."""
    raw_height = tags.get("height")
    if raw_height:
        cleaned = raw_height.strip().rstrip("m").strip()
        try:
            return float(cleaned), "OSM_TAG"
        except ValueError:
            pass  # fall through to levels/default

    levels = tags.get("building:levels")
    if levels:
        try:
            return float(levels) * METERS_PER_LEVEL, "ESTIMATED"
        except ValueError:
            pass

    return DEFAULT_BUILDING_HEIGHT, "ESTIMATED"


def _post_to_overpass(url: str, query: str):
    # Building/road queries over a real area can legitimately take a while on a
    # shared free instance - more patience here than a quick API call deserves,
    # since a timeout that's too short would misreport a slow-but-working
    # server as broken.
    return requests.post(url, data={"data": query}, headers=REQUEST_HEADERS, timeout=45)


def _run_overpass_query(south: float, north: float, west: float, east: float) -> Dict:
    query = f"""
    [out:json][timeout:25];
    (
      way["building"]({south},{west},{north},{east});
      way["highway"]({south},{west},{north},{east});
    );
    out geom;
    """
    last_error = None
    for url in [OVERPASS_URL] + OVERPASS_FALLBACK_URLS:
        try:
            resp = _post_to_overpass(url, query)
        except requests.RequestException as e:
            last_error = f"Could not reach {url}: {e}"
            continue

        if resp.status_code == 429:
            last_error = (
                "OpenStreetMap's Overpass API is rate-limiting requests right now. "
                "It's a shared free public service - wait a bit and try again."
            )
            continue
        if resp.status_code in (406, 502, 503, 504):
            # Treat these as "this particular instance is having a bad time" and
            # move on to the next mirror, rather than failing outright on the
            # first one that's under load.
            last_error = f"{url} returned HTTP {resp.status_code}."
            continue
        if resp.status_code != 200:
            last_error = f"Overpass request to {url} failed: HTTP {resp.status_code}"
            continue

        try:
            return resp.json()
        except ValueError:
            last_error = f"{url} returned a response that wasn't valid JSON."
            continue

    raise OsmFetchError(
        f"All Overpass API instances failed - last error: {last_error}. "
        f"If your selected area is large or dense with buildings, try a smaller area - "
        f"these free public instances can time out on heavy queries."
    )


def fetch_place_data(
    south: float, north: float, west: float, east: float,
    origin: Tuple[float, float], terrain_vertices: List[List[float]],
) -> Dict:
    data = _run_overpass_query(south, north, west, east)
    elements = data.get("elements", [])
    sampler = _ElevationSampler(terrain_vertices)

    buildings = []
    roads = []
    warnings: List[str] = []
    skipped_open_buildings = 0

    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        geometry = el.get("geometry")
        if not geometry or len(geometry) < 2:
            continue

        if "building" in tags:
            if len(buildings) >= MAX_BUILDINGS:
                continue
            is_closed = (
                abs(geometry[0]["lat"] - geometry[-1]["lat"]) < 1e-9
                and abs(geometry[0]["lon"] - geometry[-1]["lon"]) < 1e-9
            )
            if not is_closed or len(geometry) < 4:
                skipped_open_buildings += 1
                continue

            footprint = [_to_local_xy(pt["lat"], pt["lon"], origin) for pt in geometry[:-1]]
            centroid_x = sum(p[0] for p in footprint) / len(footprint)
            centroid_y = sum(p[1] for p in footprint) / len(footprint)
            base_elevation = sampler.sample(centroid_x, centroid_y)
            height, height_source = _parse_height(tags)

            buildings.append({
                "footprint": [[p[0], p[1]] for p in footprint],
                "base_elevation": base_elevation,
                "height": height,
                "height_source": height_source,
            })

        elif "highway" in tags:
            if len(roads) >= MAX_ROADS:
                continue
            points = []
            for pt in geometry:
                x, y = _to_local_xy(pt["lat"], pt["lon"], origin)
                z = sampler.sample(x, y)
                points.append([x, y, z])
            roads.append({"points": points, "road_type": tags.get("highway", "unknown")})

    if skipped_open_buildings > 0:
        warnings.append(
            f"Skipped {skipped_open_buildings} building(s) modeled as complex multipolygon "
            f"relations (e.g. buildings with courtyards) - not supported in this version."
        )
    if len(buildings) >= MAX_BUILDINGS:
        warnings.append(f"Capped at {MAX_BUILDINGS} buildings for this area - some were not included.")
    if len(roads) >= MAX_ROADS:
        warnings.append(f"Capped at {MAX_ROADS} roads for this area - some were not included.")

    estimated_count = sum(1 for b in buildings if b["height_source"] == "ESTIMATED")
    if estimated_count > 0:
        warnings.append(
            f"{estimated_count} of {len(buildings)} building heights are ESTIMATED "
            f"(no height/levels data in OpenStreetMap for them) - not surveyed values."
        )

    return {"buildings": buildings, "roads": roads, "warnings": warnings}
