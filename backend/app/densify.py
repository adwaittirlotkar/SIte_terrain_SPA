"""TIN densification — resample the survey surface onto a fine grid.

Survey DXF point clouds are sparse (a few hundred spot levels). Rendering
the raw TIN looks like a low-poly net, not "the actual place". This module
keeps every original survey point EXACT and adds interior grid points whose
elevations are interpolated from the TIN itself (barycentric lookup), so the
rendered mesh is smooth while remaining faithful to the surveyed ground.

The grid step adapts to site size: small plots get ~1 m cells, large sites
coarsen automatically so triangle count stays bounded (~60k max).
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import Delaunay


def densify_tin(xy: np.ndarray, z: np.ndarray, simplices: np.ndarray,
                target_tris: int = 45_000) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (xy_all, z_all, new_simplices) with a TIN-interpolated grid added.

    Original points keep their exact Z values; only NEW interior points are
    interpolated. Points outside the convex hull of the survey data are not
    added (we never invent terrain beyond what was surveyed).
    """
    if len(xy) < 3:
        return xy, z, simplices

    x0, x1 = float(xy[:, 0].min()), float(xy[:, 0].max())
    y0, y1 = float(xy[:, 1].min()), float(xy[:, 1].max())
    span_x, span_y = x1 - x0, y1 - y0
    area = max(span_x * span_y, 1e-9)

    # Grid step: aim for `target_tris` triangles over the bbox, but clamp to
    # [1 m, 25 m] so small areas stay crisp and huge ones remain renderable.
    ideal_step = np.sqrt(area / target_tris)
    step = float(np.clip(ideal_step, 1.0, 25.0))

    gx = np.arange(x0, x1 + step * 0.5, step)
    gy = np.arange(y0, y1 + step * 0.5, step)
    if len(gx) < 2 or len(gy) < 2:
        return xy, z, simplices
    gxx, gyy = np.meshgrid(gx, gy, indexing="ij")
    grid_xy = np.column_stack([gxx.ravel(), gyy.ravel()])

    hull = Delaunay(xy)                       # membership test via simplex find
    idx = hull.find_simplex(grid_xy)
    inside = idx >= 0
    grid_xy = grid_xy[inside]
    tri = idx[inside]
    if len(grid_xy) == 0:
        return xy, z, simplices

    # Barycentric interpolation of Z on the containing triangle (float64).
    T = hull.transform[tri]                    # (n, 2, 3) affine inverse transforms
    d = grid_xy - xy[hull.simplices[tri][:, 0]]
    b = np.einsum("nij,nj->ni", T[:, :2], d)   # barycentric (u, v)
    w = np.stack([1.0 - b[:, 0] - b[:, 1], b[:, 0], b[:, 1]], axis=1)
    # Clamp tiny numerical negatives before weighting.
    w = np.clip(w, 0.0, None)
    w /= w.sum(axis=1, keepdims=True)
    gz = np.einsum("ni,ni->n", w, z[hull.simplices[tri]])

    xy_all = np.vstack([xy, grid_xy])
    z_all = np.concatenate([z, gz])

    # Re-triangulate everything; originals dominate so their exact Z survives.
    full = Delaunay(xy_all)
    return xy_all, z_all, full.simplices
