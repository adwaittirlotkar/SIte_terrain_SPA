"""
Terrain generation: deterministic math only, no ML.

Survey points -> Delaunay triangulation over XY -> TIN with real Z carried
through -> per-face slope from the triangle normal.
"""

from typing import List, Dict, Any, Tuple
import numpy as np
from scipy.spatial import Delaunay


def build_tin(points: List[Dict[str, Any]]) -> Tuple[List[List[float]], List[List[int]]]:
    if len(points) < 3:
        raise ValueError("Need at least 3 points to build a TIN")

    xy = np.array([[p["x"], p["y"]] for p in points])
    z = np.array([p["z"] for p in points])

    tri = Delaunay(xy)
    vertices = np.column_stack([xy, z]).tolist()
    faces = tri.simplices.tolist()
    return vertices, faces


def elevation_stats(points: List[Dict[str, Any]]) -> Dict[str, float]:
    z = np.array([p["z"] for p in points])
    return {
        "min": float(z.min()),
        "max": float(z.max()),
        "mean": float(z.mean()),
        "range": float(z.max() - z.min()),
    }


def _face_normal(p0, p1, p2) -> np.ndarray:
    u = p1 - p0
    v = p2 - p0
    n = np.cross(u, v)
    length = np.linalg.norm(n)
    if length == 0:
        return np.array([0.0, 0.0, 1.0])
    return n / length


def face_slopes_deg(vertices: List[List[float]], faces: List[List[int]]) -> List[float]:
    V = np.array(vertices)
    slopes = []
    vertical = np.array([0.0, 0.0, 1.0])
    for f in faces:
        n = _face_normal(V[f[0]], V[f[1]], V[f[2]])
        cos_angle = min(1.0, max(-1.0, abs(float(np.dot(n, vertical)))))
        slopes.append(float(np.degrees(np.arccos(cos_angle))))
    return slopes


def average_slope_percent(vertices: List[List[float]], faces: List[List[int]]) -> float:
    slopes = face_slopes_deg(vertices, faces)
    if not slopes:
        return 0.0
    avg_deg = sum(slopes) / len(slopes)
    return float(np.tan(np.radians(avg_deg)) * 100)


def _face_normal_and_area(p0, p1, p2) -> Tuple[np.ndarray, float]:
    u = p1 - p0
    v = p2 - p0
    n = np.cross(u, v)
    length = np.linalg.norm(n)
    if length == 0:
        return np.array([0.0, 0.0, 1.0]), 0.0
    return n / length, float(length) / 2.0


# Common rule-of-thumb site-screening thresholds, not a geotechnical standard.
SLOPE_BANDS = [
    ("buildable_pct", 0.0, 10.0),
    ("moderate_pct", 10.0, 25.0),
    ("steep_pct", 25.0, float("inf")),
]


def slope_area_breakdown(vertices: List[List[float]], faces: List[List[int]]) -> Dict[str, float]:
    """
    Area-weighted (not just face-count-weighted) breakdown of the site by
    slope steepness, in bands commonly used for a first-pass development
    feasibility screen. This is a screening heuristic, not a substitute
    for an actual geotechnical/civil assessment before building anything.
    """
    V = np.array(vertices)
    vertical = np.array([0.0, 0.0, 1.0])
    band_areas = {name: 0.0 for name, _, _ in SLOPE_BANDS}
    total_area = 0.0

    for f in faces:
        n, area = _face_normal_and_area(V[f[0]], V[f[1]], V[f[2]])
        if area == 0:
            continue
        cos_angle = min(1.0, max(-1.0, abs(float(np.dot(n, vertical)))))
        slope_deg = float(np.degrees(np.arccos(cos_angle)))
        total_area += area
        for name, lo, hi in SLOPE_BANDS:
            if lo <= slope_deg < hi:
                band_areas[name] += area
                break

    if total_area == 0:
        return {name: 0.0 for name, _, _ in SLOPE_BANDS}
    return {name: round(area / total_area * 100, 1) for name, area in band_areas.items()}


def contour_lines(vertices: List[List[float]], faces: List[List[int]], interval: float = 1.0) -> List[Dict[str, Any]]:
    """
    Very small marching-triangles contour extractor. For each triangle,
    for each contour level that crosses it, linearly interpolate the
    crossing points along the two edges that straddle the level.
    """
    V = np.array(vertices)
    if len(V) == 0:
        return []

    z_min, z_max = float(V[:, 2].min()), float(V[:, 2].max())
    if z_max <= z_min:
        return []

    start_level = np.ceil(z_min / interval) * interval
    levels = np.arange(start_level, z_max, interval)

    segments_by_level: Dict[float, List[List[List[float]]]] = {float(lvl): [] for lvl in levels}

    for f in faces:
        tri_pts = V[f]
        for lvl in levels:
            lvl = float(lvl)
            above = tri_pts[:, 2] >= lvl
            # A contour crosses this triangle only if it's not all-above or all-below
            if above.all() or (~above).all():
                continue
            crossing_points = []
            for i in range(3):
                j = (i + 1) % 3
                z0, z1 = tri_pts[i][2], tri_pts[j][2]
                if (z0 - lvl) * (z1 - lvl) < 0:
                    t = (lvl - z0) / (z1 - z0)
                    pt = tri_pts[i] + t * (tri_pts[j] - tri_pts[i])
                    crossing_points.append(pt.tolist())
            if len(crossing_points) == 2:
                segments_by_level[lvl].append(crossing_points)

    return [
        {"elevation": lvl, "segments": segs}
        for lvl, segs in segments_by_level.items()
        if segs
    ]
