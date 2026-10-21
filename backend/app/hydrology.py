"""
Surface water flow accumulation (D8 algorithm) - a real, standard
hydrology computation on real elevation data.

IMPORTANT DISTINCTION, worth restating in code as well as in the UI:
this tells you where surface water tends to FLOW and POOL based on the
shape of the ground - drainage channels, low points, ridges. It says
NOTHING about groundwater / water table depth, which depends on
subsurface geology this project has no data source for at all. Treat
this as "where would rain run to on this site," not "how deep is the
water underground."

This is pure NumPy on the same DEM GeoTIFF already saved for a
location-fetched project, so it works out of the box wherever the rest
of the app does.
"""

import os
from typing import Optional

import numpy as np
import rasterio


class HydrologyError(Exception):
    pass


# 8-connectivity neighbor offsets: (row_delta, col_delta, real distance in cell-units)
_NEIGHBORS = [
    (-1, -1, 1.4142135), (-1, 0, 1.0), (-1, 1, 1.4142135),
    (0, -1, 1.0),                       (0, 1, 1.0),
    (1, -1, 1.4142135),  (1, 0, 1.0),  (1, 1, 1.4142135),
]


def d8_flow_accumulation(elevation: np.ndarray, nodata: Optional[float] = None) -> np.ndarray:
    """
    Each cell flows to its single steepest downhill neighbor. Accumulation
    at a cell = 1 (itself) + everything that flowed into it. Processed in
    descending elevation order, so a cell's inflow is always finalized
    before it passes flow onward - correct because a cell only ever flows
    to a strictly lower neighbor, which rules out cycles.
    """
    rows, cols = elevation.shape
    valid = np.ones((rows, cols), dtype=bool) if nodata is None else (elevation != nodata)

    flow_to = np.full((rows, cols, 2), -1, dtype=int)
    for i in range(rows):
        for j in range(cols):
            if not valid[i, j]:
                continue
            best_slope = 0.0
            best_target = None
            for di, dj, dist in _NEIGHBORS:
                ni, nj = i + di, j + dj
                if 0 <= ni < rows and 0 <= nj < cols and valid[ni, nj]:
                    drop = elevation[i, j] - elevation[ni, nj]
                    slope = drop / dist
                    if slope > best_slope:
                        best_slope = slope
                        best_target = (ni, nj)
            if best_target:
                flow_to[i, j] = best_target

    accum = np.where(valid, 1.0, 0.0).astype(np.float64)
    order = np.argsort(-np.where(valid, elevation, -np.inf).ravel())
    for idx in order:
        i, j = divmod(int(idx), cols)
        if not valid[i, j]:
            continue
        ti, tj = flow_to[i, j]
        if ti >= 0:
            accum[ti, tj] += accum[i, j]
    return accum


def generate_drainage_png(dem_path: str, out_path: str) -> str:
    """Reads a DEM GeoTIFF, computes flow accumulation, writes a blue-intensity
    PNG (log-scaled, since accumulation values span a huge range) for use as
    a terrain texture. Returns out_path."""
    from PIL import Image

    with rasterio.open(dem_path) as src:
        elevation = src.read(1).astype(np.float64)
        nodata = src.nodata

    if elevation.size == 0:
        raise HydrologyError(f"'{dem_path}' has no data to analyze.")

    accum = d8_flow_accumulation(elevation, nodata=nodata)

    # Log scale: a handful of cells carry enormous accumulation (the main
    # drainage channel) while most carry very little - a linear scale would
    # make everything except a few pixels look identical.
    log_accum = np.log1p(accum)
    lo, hi = float(log_accum.min()), float(log_accum.max())
    rng = max(hi - lo, 1e-6)
    normalized = np.clip((log_accum - lo) / rng, 0, 1)

    # Render as blue intensity on a light base, rather than grayscale -
    # reads immediately as "water," which matters for a feature whose whole
    # point is not being mistaken for something more authoritative than it is.
    rgb = np.zeros((*normalized.shape, 3), dtype=np.uint8)
    rgb[..., 0] = ((1 - normalized) * 235).astype(np.uint8)  # R
    rgb[..., 1] = ((1 - normalized * 0.5) * 235).astype(np.uint8)  # G
    rgb[..., 2] = 235  # B stays high throughout - always reads as "water-ish"

    Image.fromarray(rgb, mode="RGB").save(out_path)
    return out_path
