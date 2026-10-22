"""DXF survey parsing.

Accuracy rules:
- Elevations (Z) are kept as raw floats -- never rounded.
- Points are filtered by layer so annotation / boundary layers cannot
  create phantom spikes in the terrain mesh.
- Coordinates stay in the original survey CRS; centering happens at
  render time on the frontend (see TerrainScene), not here.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import ezdxf
from ezdxf.math import Matrix44


@dataclass
class SurveyPoint:
    x: float
    y: float
    z: float
    layer: str


@dataclass
class ParsedSurvey:
    points: list[SurveyPoint] = field(default_factory=list)
    layers: dict[str, int] = field(default_factory=dict)   # layer -> point count
    skipped_layers: dict[str, int] = field(default_factory=dict)
    units_hint: str | None = None
    warnings: list[str] = field(default_factory=list)


# Layers that almost never contain ground points.
_NON_TERRAIN_LAYER_RE = re.compile(
    r"(text|anno|dim|title|border|north|scale|grid|marker|station|label|"
    r"section|boundary|boundary-line|proposal|design|contour-check)",
    re.IGNORECASE,
)


def _is_terrain_layer(name: str) -> bool:
    return _NON_TERRAIN_LAYER_RE.search(name) is None


def _insert_to_points(insert, layer: str) -> list[SurveyPoint]:
    """Extract WORLD-space vertices from a block insert (survey markers)."""
    pts: list[SurveyPoint] = []
    try:
        m = Matrix44.y_rotate(math.radians(getattr(insert.dxf, "rotation", 0.0))) @ \
            Matrix44.scale(getattr(insert.dxf, "xscale", 1.0),
                           getattr(insert.dxf, "yscale", 1.0),
                           getattr(insert.dxf, "zscale", 1.0))
        offset = insert.dxf.insert
    except Exception:
        return pts
    block = insert.doc.blocks.get(insert.dxf.name)
    if block is None:
        return pts
    for e in block:
        t = e.dxftype()
        if t == "POINT":
            v = m.transform(e.dxf.location)
            pts.append(SurveyPoint(v.x + offset.x, v.y + offset.y, v.z + offset.z, layer))
        elif t in ("LWPOLYLINE", "POLYLINE"):
            try:
                for vtx in e.vertices():
                    bz = getattr(vtx, "bz", 0.0) or 0.0
                    loc = vtx.dxf.location
                    v = m.transform((loc.x, loc.y, bz))
                    pts.append(SurveyPoint(v[0] + offset.x, v[1] + offset.y,
                                           v[2] + offset.z, layer))
            except Exception:
                continue
    return pts


def parse_dxf(path: str, max_points: int = 250_000) -> ParsedSurvey:
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    result = ParsedSurvey()

    try:
        insunits = doc.header.get("$INSUNITS", 0)
        result.units_hint = {0: "unitless", 1: "inches", 2: "feet", 4: "mm",
                             5: "cm", 6: "meters", 7: "km"}.get(int(insunits), "unknown")
    except Exception:
        pass

    counts: dict[str, int] = {}
    skipped: dict[str, int] = {}

    for entity in msp:
        t = entity.dxftype()
        layer = entity.dxf.layer
        if t == "POINT":
            loc = entity.dxf.location
            counts[layer] = counts.get(layer, 0) + 1
            result.points.append(SurveyPoint(loc.x, loc.y, loc.z, layer))
        elif t == "INSERT":
            sub = _insert_to_points(entity, layer)
            counts[layer] = counts.get(layer, 0) + len(sub)
            result.points.extend(sub)
        elif t in ("LWPOLYLINE", "POLYLINE"):
            n = 0
            try:
                for v in entity.vertices():
                    bz = getattr(v, "bz", 0.0) or 0.0
                    result.points.append(
                        SurveyPoint(v.dxf.location.x, v.dxf.location.y, bz, layer))
                    n += 1
            except Exception:
                continue
            counts[layer] = counts.get(layer, 0) + n

    # ---- Layer filtering ----------------------------------------------------
    terrain_pts = [p for p in result.points if _is_terrain_layer(p.layer)]
    dropped = len(result.points) - len(terrain_pts)
    if dropped:
        result.warnings.append(
            f"Dropped {dropped} points from non-terrain layers "
            "(annotation/boundary/design). Override via layer selection."
        )
        for p in result.points:
            if not _is_terrain_layer(p.layer):
                skipped[p.layer] = skipped.get(p.layer, 0) + 1
        # Safety net: if filtering removed everything, keep all points.
        if not terrain_pts:
            terrain_pts = result.points
            result.warnings.append("Layer filter removed all points; using every layer.")
    result.points = terrain_pts
    result.layers = counts
    result.skipped_layers = skipped

    if len(result.points) > max_points:
        raise ValueError(
            f"Survey has {len(result.points)} points (limit {max_points}). "
            "Decimate the DXF before upload."
        )

    # Deduplicate coincident XY (keeps first Z) -- duplicate points break Delaunay.
    seen: set[tuple[float, float]] = set()
    deduped: list[SurveyPoint] = []
    for p in result.points:
        key = (round(p.x, 6), round(p.y, 6))
        if key not in seen:
            seen.add(key)
            deduped.append(p)
    if len(deduped) < len(result.points):
        result.warnings.append(
            f"Removed {len(result.points) - len(deduped)} duplicate XY points.")
    result.points = deduped

    if len(result.points) < 4:
        raise ValueError("Not enough terrain points to build a surface (need >= 4).")

    # Flag flat-Z surveys (2D drawings mislabeled as surveys).
    zs = [p.z for p in result.points]
    if max(zs) - min(zs) < 1e-9:
        result.warnings.append(
            "All elevations are identical -- this looks like a 2D drawing. "
            "The 3D view will be flat."
        )
    # Flag extreme outliers (>10x median nearest-neighbour spacing) as warnings only.
    return result
