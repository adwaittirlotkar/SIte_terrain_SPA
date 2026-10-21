"""
Real-world elevation data, fetched from the Copernicus GLO-30 DEM hosted
publicly on AWS Open Data: https://registry.opendata.aws/copernicus-dem/

No account, no API key, no rate limit imposed by us - it's a public S3
bucket served over plain HTTPS. Same underlying dataset OpenTopography
serves as "COP30", just fetched directly instead of through their API.

SWAP POINT: if this later moves to OpenTopography's API (e.g. for better
reliability guarantees, or to use a different dataset), this is the only
file that needs to change. Everything downstream - terrain.py's TIN
builder, the /api/fetch-location route in main.py - only cares about
getting back a list of {x, y, z} points in local meters, regardless of
where they came from.

Known limitations (worth surfacing to the user, not hiding):
- ~30m resolution: fine for context/massing, not survey-grade.
- It's a Digital SURFACE Model, not bare earth - in wooded or built-up
  areas it measures the top of tree canopy / rooftops, not the ground.
- Elevations are relative to the EGM2008 geoid (~global mean sea level),
  not any local survey benchmark - don't expect these numbers to match
  a local surveyor's numbers directly.
"""

import math
import os
import tempfile
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests
import rasterio
from rasterio.windows import from_bounds

COP_DEM_BASE_URL_30 = "https://copernicus-dem-30m.s3.amazonaws.com"
COP_DEM_BASE_URL_90 = "https://copernicus-dem-90m.s3.amazonaws.com"
NODATA_SENTINEL = -9000.0  # Copernicus DEM uses very negative values for nodata/ocean gaps


class ElevationFetchError(Exception):
    pass


def _tile_name(lat_deg: int, lon_deg: int) -> str:
    """
    Copernicus DEM tile filenames keep the literal '_30_' segment even
    inside the 90m bucket (confirmed against a real bucket listing - it's
    a naming-convention artifact, not a resolution indicator). What
    actually determines 30m vs 90m is which bucket you fetch from, not
    anything in the filename itself.
    """
    ns = "N" if lat_deg >= 0 else "S"
    ew = "E" if lon_deg >= 0 else "W"
    return f"Copernicus_DSM_COG_30_{ns}{abs(lat_deg):02d}_00_{ew}{abs(lon_deg):03d}_00_DEM"


def tiles_covering_bbox(south: float, north: float, west: float, east: float) -> List[Tuple[int, int]]:
    """(lat_deg, lon_deg) SW-corner keys of every 1x1 degree tile touching the bbox."""
    lat_start, lat_end = math.floor(south), math.floor(north)
    lon_start, lon_end = math.floor(west), math.floor(east)
    return [
        (lat_deg, lon_deg)
        for lat_deg in range(lat_start, lat_end + 1)
        for lon_deg in range(lon_start, lon_end + 1)
    ]


def _download_tile(lat_deg: int, lon_deg: int, dest_dir: str, resolution: int = 30) -> str:
    """Returns local path, or None (not raises) on a 404 - caller decides how to react,
    since a missing GLO-30 tile should trigger a GLO-90 fallback, not a hard failure.
    `resolution` selects which bucket to fetch from - the filename itself is the same
    in both (see _tile_name)."""
    name = _tile_name(lat_deg, lon_deg)
    base_url = COP_DEM_BASE_URL_30 if resolution == 30 else COP_DEM_BASE_URL_90
    url = f"{base_url}/{name}/{name}.tif"
    dest_path = os.path.join(dest_dir, f"{name}_{resolution}m.tif")

    if os.path.exists(dest_path):
        return dest_path

    try:
        resp = requests.get(url, stream=True, timeout=60)
    except requests.RequestException as e:
        raise ElevationFetchError(f"Could not reach the elevation data source: {e}")

    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise ElevationFetchError(f"Failed to download elevation tile '{name}': HTTP {resp.status_code}")

    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)
    return dest_path


def _download_tiles_with_fallback(
    tile_keys: List[Tuple[int, int]], cache_dir: str
) -> Tuple[List[str], int, List[str]]:
    """
    Tries GLO-30 for every tile the bbox needs. If ANY of them is missing
    (returns None, i.e. a real 404 - not a network error), the whole
    request falls back to GLO-90 instead of mixing resolutions, since a
    site straddling a "released" and "not released" tile boundary should
    get one consistent resolution, not a mesh stitched from two.
    Returns (paths, resolution_used, warnings).
    """
    paths_30 = []
    missing = False
    for lat_deg, lon_deg in tile_keys:
        path = _download_tile(lat_deg, lon_deg, cache_dir, resolution=30)
        if path is None:
            missing = True
            break
        paths_30.append(path)

    if not missing:
        return paths_30, 30, []

    # Fall back to GLO-90 for the whole bbox.
    paths_90 = []
    for lat_deg, lon_deg in tile_keys:
        path = _download_tile(lat_deg, lon_deg, cache_dir, resolution=90)
        if path is None:
            raise ElevationFetchError(
                "No Copernicus elevation data available for this area at either 30m or "
                "90m resolution. This happens over open ocean, or in the small set of "
                "countries not yet released in the public dataset."
            )
        paths_90.append(path)

    warning = (
        "GLO-30 (30m resolution) elevation data isn't publicly released for this area "
        "- this happens for a small set of countries, including India, where ESA "
        "withholds the finer public dataset (likely tied to India's own restriction on "
        "distributing sub-3m-vertical-accuracy elevation data of its territory). "
        "Used GLO-90 (90m resolution) instead - still real Copernicus elevation data, "
        "just coarser."
    )
    return paths_90, 90, [warning]


def fetch_elevation_grid(south: float, north: float, west: float, east: float, cache_dir: Optional[str] = None) -> Dict:
    """
    Downloads whichever Copernicus DEM tile(s) cover the bbox (falling back
    from GLO-30 to GLO-90 if the finer dataset isn't released for this
    area - see _download_tiles_with_fallback), mosaics them if the area
    spans more than one, crops to the exact bbox, and returns every valid
    sample as parallel lat/lon/elevation lists plus any warnings raised
    along the way.
    """
    if south >= north or west >= east:
        raise ValueError("Invalid bounding box: south must be < north and west must be < east")

    area_deg2 = (north - south) * (east - west)
    if area_deg2 > 4:  # ~roughly 400km x 400km at the equator - a generous sanity cap
        raise ValueError("Selected area is too large for a single terrain fetch. Please select a smaller area.")

    cache_dir = cache_dir or tempfile.mkdtemp(prefix="dem_cache_")
    os.makedirs(cache_dir, exist_ok=True)

    tile_keys = tiles_covering_bbox(south, north, west, east)
    tile_paths, resolution_used, fetch_warnings = _download_tiles_with_fallback(tile_keys, cache_dir)

    opened = [rasterio.open(p) for p in tile_paths]
    try:
        if len(opened) == 1:
            src = opened[0]
            window = from_bounds(west, south, east, north, transform=src.transform)
            data = src.read(1, window=window)
            win_transform = src.window_transform(window)
        else:
            from rasterio.merge import merge
            mosaic, transform = merge(opened)
            window = from_bounds(west, south, east, north, transform=transform)
            row_off, col_off = int(window.row_off), int(window.col_off)
            row_end = row_off + int(window.height)
            col_end = col_off + int(window.width)
            data = mosaic[0, max(row_off, 0):row_end, max(col_off, 0):col_end]
            from rasterio.transform import Affine
            win_transform = transform * Affine.translation(max(col_off, 0), max(row_off, 0))
    finally:
        for s in opened:
            s.close()

    if data.size == 0:
        raise ElevationFetchError("Selected area returned no elevation data - check the coordinates.")

    rows, cols = data.shape
    lats, lons, elevations = [], [], []
    for r in range(rows):
        for c in range(cols):
            z = float(data[r, c])
            if z <= NODATA_SENTINEL:
                continue
            lon, lat = win_transform * (c + 0.5, r + 0.5)
            lats.append(lat)
            lons.append(lon)
            elevations.append(z)

    if len(elevations) < 3:
        raise ElevationFetchError(
            "Not enough valid elevation samples in the selected area "
            "(it may be entirely ocean or in a data gap)."
        )

    return {
        "lats": lats,
        "lons": lons,
        "elevations": elevations,
        "resolution_m": resolution_used,
        "warnings": fetch_warnings,
        # Raw grid + georeferencing, kept alongside the flattened lists above in
        # case a future feature wants this written out as a real GeoTIFF (see
        # save_grid_as_geotiff) rather than just the triangulated point list.
        "raw_grid": data,
        "transform": win_transform,
        "crs": "EPSG:4326",
    }


def save_grid_as_geotiff(data: np.ndarray, transform, crs: str, out_path: str) -> str:
    """
    Writes the cropped elevation grid to a real, georeferenced GeoTIFF on disk.
    This is what makes the data usable by external raster tools (QGIS, GDAL CLI,
    etc.) rather than just living as an in-memory array for our own TIN builder.
    """
    profile = {
        "driver": "GTiff",
        "height": data.shape[0],
        "width": data.shape[1],
        "count": 1,
        "dtype": str(data.dtype),
        "crs": crs,
        "transform": transform,
        "nodata": NODATA_SENTINEL,
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)
    return out_path


def fetch_elevation_grid_bare_earth(
    south: float, north: float, west: float, east: float, cache_dir: Optional[str] = None
) -> Dict:
    """
    Same result shape as fetch_elevation_grid, but sourced from FABDEM
    (Forest And Buildings-removed Copernicus DEM, University of Bristol) -
    the SAME underlying 30m Copernicus grid, but ML-corrected to strip out
    tree canopy and rooftop height, giving true bare-earth ground level
    instead of "top of whatever's sitting there." Same resolution as the
    default source, genuinely better accuracy on wooded/built-up sites.

    Honesty note: FABDEM is distributed via a smaller, community-maintained
    public source rather than Copernicus's official AWS Open Data hosting -
    less institutionally durable. If this keeps failing, "Surface"
    (Copernicus direct) is the more reliable fallback.
    """
    import fabdem

    if south >= north or west >= east:
        raise ValueError("Invalid bounding box: south must be < north and west must be < east")

    area_deg2 = (north - south) * (east - west)
    if area_deg2 > 4:
        raise ValueError("Selected area is too large for a single terrain fetch. Please select a smaller area.")

    cache_dir = cache_dir or tempfile.mkdtemp(prefix="fabdem_cache_")
    os.makedirs(cache_dir, exist_ok=True)
    dem_path = os.path.join(cache_dir, f"fabdem_{south:.4f}_{west:.4f}_{north:.4f}_{east:.4f}.tif")

    if not os.path.exists(dem_path):
        try:
            fabdem.download((west, south, east, north), output_path=dem_path,
                             cache=os.path.join(cache_dir, "raw"))
        except Exception as e:
            raise ElevationFetchError(
                f"Could not fetch FABDEM bare-earth elevation data: {e}. FABDEM is distributed "
                f"via a smaller community-maintained source than Copernicus - if this keeps "
                f"failing, try 'Surface' (Copernicus) instead, which is more reliably hosted."
            )

    with rasterio.open(dem_path) as src:
        window = from_bounds(west, south, east, north, transform=src.transform)
        data = src.read(1, window=window)
        win_transform = src.window_transform(window)
        nodata = src.nodata

    if data.size == 0:
        raise ElevationFetchError("Selected area returned no elevation data - check the coordinates.")

    rows, cols = data.shape
    lats, lons, elevations = [], [], []
    for r in range(rows):
        for c in range(cols):
            z = float(data[r, c])
            if (nodata is not None and z == nodata) or z <= NODATA_SENTINEL:
                continue
            lon, lat = win_transform * (c + 0.5, r + 0.5)
            lats.append(lat)
            lons.append(lon)
            elevations.append(z)

    if len(elevations) < 3:
        raise ElevationFetchError(
            "Not enough valid elevation samples in the selected area "
            "(it may be entirely ocean or in a data gap)."
        )

    return {
        "lats": lats,
        "lons": lons,
        "elevations": elevations,
        "resolution_m": 30,
        "warnings": [],
        "raw_grid": data,
        "transform": win_transform,
        "crs": "EPSG:4326",
    }


def to_local_points(
    lats: List[float], lons: List[float], elevations: List[float], origin: Optional[Tuple[float, float]] = None
) -> Tuple[List[Dict[str, float]], Tuple[float, float]]:
    """
    Converts lat/lon/elevation into a local flat XY-in-meters point cloud,
    the same shape terrain.build_tin() already expects from DXF surveys.

    Uses a simple equirectangular approximation centered on `origin` (or
    the data's own centroid if none given). This is intentionally simple -
    no UTM/pyproj dependency - and is accurate to a small fraction of a
    percent across a site a few km wide. Fine for visualization; not for
    legal/survey-grade measurement.

    Pass the same `origin` back in (e.g. when converting boundary corners)
    to keep everything in one consistent local coordinate system.
    """
    if origin is None:
        lat0 = sum(lats) / len(lats)
        lon0 = sum(lons) / len(lons)
    else:
        lat0, lon0 = origin

    lat0_rad = math.radians(lat0)
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = 111_320.0 * math.cos(lat0_rad)

    points = [
        {"x": (lon - lon0) * meters_per_deg_lon, "y": (lat - lat0) * meters_per_deg_lat, "z": z}
        for lat, lon, z in zip(lats, lons, elevations)
    ]
    return points, (lat0, lon0)
