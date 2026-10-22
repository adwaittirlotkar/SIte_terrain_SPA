"""Fetch real elevation from the Copernicus GLO-30 DEM (AWS Open Data).

Reads Cloud-Optimised GeoTIFF tiles over HTTP via rasterio — nothing needs to
be downloaded or stored locally by the user. Tiles are addressed with
mercantile so only the COGs overlapping the requested bbox are opened.

Returns a regular grid of elevations (metres above sea level, ~30 m cells)
which main.py converts into survey-style points for the same TIN pipeline
used for DXF uploads.
"""
from __future__ import annotations

import math

import numpy as np

# Copernicus DEM GLO-30 on Registry of Open Data on AWS (public, no key).
COG_URL = (
    "https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_N{ns:03d}_00_E{ew:04d}_00_DEM/"
    "Copernicus_DSM_COG_10_N{ns:03d}_00_E{ew:04d}_00_DEM.tif"
)


def _tile_names(lat: float, lon: float) -> list[str]:
    """All tile names whose coverage touches (lat, lon) incl. 1 deg buffer."""
    ns_lo, ns_hi = int(math.floor(lat)) - 1, int(math.floor(lat)) + 1
    ew_lo, ew_hi = int(math.floor(lon)) - 1, int(math.floor(lon)) + 1
    out = []
    for ns in range(ns_lo, ns_hi + 1):
        for ew in range(ew_lo, ew_hi + 1):
            if ns < 0 or ew < 0:
                continue  # this bucket layout covers N/E hemispheres; India ok
            out.append(COG_URL.format(ns=ns, ew=ew))
    return out


def fetch_grid(lat: float, lon: float, half_m: float = 150.0,
               cell_px: int = 64) -> dict:
    """Sample a lat x lon grid of elevations around a point.

    half_m : site radius in metres (bbox half-extent)
    cell_px: grid resolution per axis (~30 m DEM supports up to ~half_m/15)
    """
    import mercantile
    import rasterio
    from rasterio.warp import transform_bounds

    # metre bbox -> degrees (approximate, fine at these scales)
    dlat = half_m / 111_320.0
    dlon = half_m / (111_320.0 * max(0.2, math.cos(math.radians(lat))))
    west, south = lon - dlon, lat - dlat
    east, north = lon + dlon, lat + dlat

    xs = np.linspace(west, east, cell_px)
    ys = np.linspace(south, north, cell_px)

    z = np.full((cell_px, cell_px), np.nan, dtype=np.float64)

    # DEM buckets are 1°x1°; just enumerate the (few) that overlap the bbox
    tiles = set()
    for ns in range(int(math.floor(south)), int(math.floor(north)) + 2):
        for ew in range(int(math.floor(west)), int(math.floor(east)) + 2):
            if ns >= 0 and ew >= 0:
                tiles.add(COG_URL.format(ns=ns, ew=ew))

    last_err = None
    opened = False
    for url in sorted(tiles):
        try:
            with rasterio.open(f"/vsicurl/{url}") as src:
                tb = transform_bounds(src.crs, "EPSG:4326",
                                      *src.bounds, densify_pts=21)
                if tb[2] < west or tb[0] > east or tb[3] < south or tb[1] > north:
                    continue
                window = rasterio.windows.from_bounds(
                    west, south, east, north, src.transform)
                data = src.read(
                    1, window=window, boundless=True,
                    fill_value=float("nan"),
                    out_shape=(cell_px, cell_px)).astype(np.float64)
                mask = ~np.isnan(data) & (data > -100) & (data < 9000)
                # merge: only fill cells that are still NaN
                upd = np.isnan(z) & mask
                z[upd] = data[upd]
                opened = True
        except Exception as e:  # missing tile bucket (ocean / other hemisphere)
            last_err = e
            continue

    if not opened:
        raise ValueError(
            "No elevation data found for this location from the public "
            "Copernicus GLO-30 tiles"
            + (f" (last error: {last_err})" if last_err else "")
        )

    # drop any rows/cols still fully nan
    good_rows = ~np.all(np.isnan(z), axis=1)
    good_cols = ~np.all(np.isnan(z), axis=0)
    z = z[np.ix_(good_rows, good_cols)]
    yy = ys[good_rows]
    xx = xs[good_cols]
    if z.size == 0:
        raise ValueError("DEM returned empty data for this area.")

    gx, gy = np.meshgrid(xx, yy)
    return {"lons": gx.ravel(), "lats": gy.ravel(), "elev": z.ravel()}
