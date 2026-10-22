"""Delaunay TIN construction + raw-elevation statistics.

No rounding of elevations anywhere. Slope is computed from triangle
normals WITHOUT vertical exaggeration (exaggeration is a display-only
concept applied in the viewer).
"""
from __future__ import annotations

import math
import numpy as np
from scipy.spatial import Delaunay

from .dxf_parser import SurveyPoint


def _loose_slope_prune(xy: np.ndarray, z: np.ndarray, simplices: np.ndarray,
                       max_slope_deg: float = 75.0) -> np.ndarray:
    """Remove sliver triangles that span gaps between scattered points.

    A triangle whose plane slope exceeds `max_slope_deg` is almost always a
    "skirt" across missing data (or a surviving phantom spike), not real
    ground. Dropping them keeps the TIN honest without touching raw Z values.
    """
    a = xy[simplices[:, 0]]; b = xy[simplices[:, 1]]; c = xy[simplices[:, 2]]
    za = z[simplices[:, 0]]; zb = z[simplices[:, 1]]; zc = z[simplices[:, 2]]
    ab = b - a; ac = c - a
    det = ab[:, 0] * ac[:, 1] - ab[:, 1] * ac[:, 0]
    ok = np.abs(det) > 1e-12
    det_safe = np.where(ok, det, 1.0)
    dzab = zb - za; dzac = zc - za
    gx = (dzab * ac[:, 1] - dzac * ab[:, 1]) / det_safe
    gy = (dzac * ab[:, 0] - dzab * ab[:, 0]) / det_safe
    slopes = np.degrees(np.arctan(np.sqrt(gx**2 + gy**2)))
    keep = ok & (slopes <= max_slope_deg)
    return simplices[keep]


def build_tin(points: list[SurveyPoint]) -> dict:
    xy = np.array([(p.x, p.y) for p in points], dtype=np.float64)
    z = np.array([p.z for p in points], dtype=np.float64)

    tri = Delaunay(xy)
    simplices = tri.simplices  # (M,3) indices

    # Edge-aware pruning: drop sliver triangles spanning gaps/phantom spikes.
    n_before = len(simplices)
    simplices = _loose_slope_prune(xy, z, simplices)
    pruned = n_before - len(simplices)

    # Densify: add TIN-interpolated grid points so the rendered surface looks
    # like the actual place instead of a sparse low-poly net. Original survey
    # points keep their exact Z; only interior grid nodes are interpolated.
    try:
        from .densify import densify_tin
        xy, z, simplices = densify_tin(xy, z, simplices)
        # Re-derive slope on the dense mesh (prune again is unnecessary:
        # interpolated points lie exactly on surviving planes).
    except Exception:
        pass  # never fail an upload because of densification

    # Triangle normals & slope/aspect (2D XY cross-product z-component only;
    # true slope needs the Z gradient, computed below from plane fit).
    a = xy[simplices[:, 0]]; b = xy[simplices[:, 1]]; c = xy[simplices[:, 2]]
    za = z[simplices[:, 0]]; zb = z[simplices[:, 1]]; zc = z[simplices[:, 2]]
    ab = b - a; ac = c - a
    cross_z = ab[:, 0] * ac[:, 1] - ab[:, 1] * ac[:, 0]        # signed area*2
    # Gradient of the plane through (a,za),(b,zb),(c,zc):
    # dz/dx, dz/dy solved from the 2x2 system [ab ac]^T.
    det = cross_z
    ok = np.abs(det) > 1e-12
    det_safe = np.where(ok, det, 1.0)
    dzab = zb - za; dzac = zc - za
    gx = (dzab * ac[:, 1] - dzac * ab[:, 1]) / det_safe
    gy = (dzac * ab[:, 0] - dzab * ab[:, 0]) / det_safe
    slopes_deg = np.degrees(np.arctan(np.sqrt(gx**2 + gy**2)))
    slopes_deg[~ok] = 0.0

    return {
        "points_xy": xy,
        "z": z,
        "simplices": simplices,
        "slope_deg_per_triangle": slopes_deg,
        "pruned_triangles": int(pruned),
    }


def compute_stats(tin: dict) -> dict:
    z = tin["z"]
    xy = tin["points_xy"]
    slopes = tin["slope_deg_per_triangle"]
    cx = float(xy[:, 0].mean()); cy = float(xy[:, 1].mean())
    span = float(max(xy.max(axis=0) - xy.min(axis=0)))
    # Slopes of surviving triangles only; if everything was pruned, fall back
    # to 0 so downstream code never sees NaN.
    s_min = float(slopes.min()) if len(slopes) else 0.0
    s_max = float(slopes.max()) if len(slopes) else 0.0
    s_mean = float(slopes.mean()) if len(slopes) else 0.0
    return {
        "point_count": int(len(z)),
        "triangle_count": int(len(tin["simplices"])),
        "pruned_triangles": int(tin.get("pruned_triangles", 0)),
        "min_elev": float(z.min()),
        "max_elev": float(z.max()),
        "mean_elev": float(z.mean()),
        "relief": float(z.max() - z.min()),
        "centroid": [cx, cy],
        "span_m": span,
        "slope_min_deg": s_min,
        "slope_max_deg": s_max,
        "slope_mean_deg": s_mean,
        # Raw float64 arrays serialised for the viewer (no rounding).
        "positions": np.concatenate([xy, z[:, None]], axis=1).tolist(),
        "triangles": tin["simplices"].tolist(),
    }


def dynamic_contour_interval(stats: dict) -> float:
    """Pick contour interval from relief and point density.

    Target ~12-20 contour lines so the map stays readable whether the
    site is a 0.5 m lot or a 40 m hillside.
    """
    relief = max(stats["relief"], 1e-6)
    raw = relief / 15.0
    # Snap to a nice number: 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10 ...
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        cand = m * mag
        if cand >= raw:
            return cand
    return 10 * mag
