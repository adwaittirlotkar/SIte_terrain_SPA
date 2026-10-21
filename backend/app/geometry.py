"""2D site geometry - boundary area/perimeter, no AI needed for this."""

from typing import List, Tuple, Dict, Any
from shapely.geometry import Polygon


def analyze_boundary(points_xy: List[Tuple[float, float]]) -> Dict[str, Any]:
    poly = Polygon(points_xy)
    if not poly.is_valid:
        poly = poly.buffer(0)

    centroid = poly.centroid
    minx, miny, maxx, maxy = poly.bounds

    return {
        "area_m2": float(poly.area),
        "perimeter_m": float(poly.length),
        "centroid": [float(centroid.x), float(centroid.y)],
        "bounds": {"min_x": minx, "min_y": miny, "max_x": maxx, "max_y": maxy},
    }
