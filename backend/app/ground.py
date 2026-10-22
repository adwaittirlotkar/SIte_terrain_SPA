"""Ground elevation sampling on the site TIN (for BIM placement & cut/fill).

Deterministic linear interpolation over Delaunay triangles -- no AI.
Used by /api/building/{pid}/sample so the viewer can drop a building base
exactly onto the terrain and compute cut/fill volumes against a footprint.
"""
from __future__ import annotations

import numpy as np
from matplotlib.path import Path as MplPath


def _ring_area(ring) -> float:
    """Shoelace area of a closed/open [x,y] ring (m2)."""
    pts = np.asarray(ring, dtype=float)
    if pts.shape[0] > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    x, y = pts[:, 0], pts[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


def _find_tri(xy: np.ndarray, simplices: np.ndarray, x: float, y: float):
    """Locate the triangle containing (x, y); returns (tri_index, w0, w1, w2)
    or None if outside every triangle."""
    px = xy[simplices[:, 0], 0]
    py = xy[simplices[:, 0], 1]
    v0x = xy[simplices[:, 1], 0] - px
    v0y = xy[simplices[:, 1], 1] - py
    v1x = xy[simplices[:, 2], 0] - px
    v1y = xy[simplices[:, 2], 1] - py
    dx = x - px
    dy = y - py
    den = v0x * v1y - v1x * v0y
    ok = np.abs(den) > 1e-12
    w1 = np.where(ok, (dx * v1y - dy * v1x) / np.where(ok, den, 1), -1.0)
    w2 = np.where(ok, (v0x * dy - v0y * dx) / np.where(ok, den, 1), -1.0)
    w0 = 1.0 - w1 - w2
    inside = ok & (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
    hits = np.nonzero(inside)[0]
    if len(hits) == 0:
        return None
    i = int(hits[0])
    return i, float(w0[i]), float(w1[i]), float(w2[i])


def sample_ground(xy: np.ndarray, z: np.ndarray, simplices: np.ndarray,
                  points: list[list[float]]) -> dict:
    """Sample elevations at survey-coordinate points.

    Returns {elevations: [z|null...], outside: int} where null means the point
    lies outside the TIN (no surveyed ground there).
    """
    out: list[float | None] = []
    n_outside = 0
    for x, y in points:
        hit = _find_tri(xy, simplices, float(x), float(y))
        if hit is None:
            # nearest fallback would fabricate ground; report as outside.
            out.append(None)
            n_outside += 1
        else:
            _, w0, w1, w2 = hit
            ia, ib, ic = simplices[_]
            out.append(float(w0 * z[ia] + w1 * z[ib] + w2 * z[ic]))
    return {"elevations": out, "outside": n_outside}


def cut_fill(xy: np.ndarray, z: np.ndarray, simplices: np.ndarray,
             ring: list[list[float]], level: float, cell: float) -> dict:
    """Grid-based cut/fill volume between a flat platform level and the TIN
    inside a closed footprint ring (survey coords). Deterministic, exact-enough
    for design decisions (error ~ O(cell^2) along edges)."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    pts = np.asarray(ring, dtype=np.float64)
    # Shoelace area of the closed footprint ring.
    fp_area = float(abs(np.dot(pts[:, 0], np.roll(pts[:, 1], -1))
                        - np.dot(pts[:, 1], np.roll(pts[:, 0], -1))) / 2.0)
    path = MplPath(pts)
    gx = np.arange(min(xs), max(xs), cell)
    gy = np.arange(min(ys), max(ys), cell)
    cut = fill = 0.0
    area_cell = cell * cell
    grid_pts = [(float(x), float(y)) for x in gx for y in gy]
    inside_mask = path.contains_points(np.asarray(grid_pts))
    samp = sample_ground(xy, z, simplices, grid_pts)
    for (x, y), ins, gz in zip(grid_pts, inside_mask, samp["elevations"]):
        if not ins or gz is None:
            continue
        d = level - gz
        if d > 0:
            cut += d * area_cell
        else:
            fill += -d * area_cell
    return {"cut_m3": cut, "fill_m3": fill,
            "net_m3": cut - fill, "platform_level": level,
            "footprint_area_m2": _ring_area(ring),
            "cell_m": cell}
