"""
DXF parsing.

Deliberately narrow scope for v1: we pull raw X/Y/Z survey points and
closed-polyline boundary candidates out of a DXF file. No inference,
no guessing at semantics beyond "this entity has coordinates and a layer
name." Anything fancier (auto-classifying buildings/roads/trees) is a
v2 problem and should be labeled INFERRED when it lands.
"""

from typing import List, Dict, Any
import ezdxf
from ezdxf.document import Drawing


class DxfParseError(Exception):
    pass


def _open(path: str) -> Drawing:
    try:
        return ezdxf.readfile(path)
    except IOError as e:
        raise DxfParseError(f"Could not read file: {e}")
    except ezdxf.DXFStructureError as e:
        raise DxfParseError(f"Invalid or corrupt DXF structure: {e}")


def extract_survey_points(path: str) -> List[Dict[str, Any]]:
    """Walk modelspace and pull every entity that carries real X/Y/Z data."""
    doc = _open(path)
    msp = doc.modelspace()
    points: List[Dict[str, Any]] = []

    for e in msp:
        dxftype = e.dxftype()
        layer = e.dxf.layer

        try:
            if dxftype == "POINT":
                loc = e.dxf.location
                points.append({"x": loc.x, "y": loc.y, "z": loc.z, "layer": layer, "source": "POINT"})

            elif dxftype == "LWPOLYLINE":
                elevation = e.dxf.elevation if e.dxf.hasattr("elevation") else 0.0
                for p in e.get_points(format="xy"):
                    points.append({"x": p[0], "y": p[1], "z": elevation, "layer": layer, "source": "LWPOLYLINE"})

            elif dxftype == "POLYLINE":
                for v in e.vertices:
                    loc = v.dxf.location
                    points.append({"x": loc.x, "y": loc.y, "z": loc.z, "layer": layer, "source": "POLYLINE"})

            elif dxftype == "3DFACE":
                for corner in ("vtx0", "vtx1", "vtx2", "vtx3"):
                    loc = e.dxf.get(corner, None)
                    if loc is not None:
                        points.append({"x": loc.x, "y": loc.y, "z": loc.z, "layer": layer, "source": "3DFACE"})

            elif dxftype == "LINE":
                start, end = e.dxf.start, e.dxf.end
                points.append({"x": start.x, "y": start.y, "z": start.z, "layer": layer, "source": "LINE"})
                points.append({"x": end.x, "y": end.y, "z": end.z, "layer": layer, "source": "LINE"})

            # TEXT / MTEXT / INSERT / HATCH deliberately skipped in v1 -
            # they carry annotation or block-reference semantics, not
            # raw elevation data we can trust for a TIN.
        except (AttributeError, TypeError):
            # Malformed entity - skip it rather than crash the whole upload.
            continue

    return points


def find_boundary_candidates(path: str) -> List[Dict[str, Any]]:
    """Closed polylines are the only boundary candidates we trust in v1.

    Covers both the modern LWPOLYLINE (single entity, R14+) and the
    classic POLYLINE/VERTEX/SEQEND form (R12-era, still common from
    older CAD exports or hand-authored DXF).
    """
    doc = _open(path)
    msp = doc.modelspace()
    candidates = []

    for e in msp:
        if e.dxftype() == "LWPOLYLINE" and e.closed:
            pts = [(p[0], p[1]) for p in e.get_points(format="xy")]
            if len(pts) >= 3:
                candidates.append({"layer": e.dxf.layer, "points": pts, "vertex_count": len(pts)})

        elif e.dxftype() == "POLYLINE" and e.is_closed:
            pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
            if len(pts) >= 3:
                candidates.append({"layer": e.dxf.layer, "points": pts, "vertex_count": len(pts)})

    return candidates


def layer_summary(path: str) -> Dict[str, int]:
    """Entity count per layer - useful for the UI to show what's in the file."""
    doc = _open(path)
    msp = doc.modelspace()
    summary: Dict[str, int] = {}
    for e in msp:
        summary[e.dxf.layer] = summary.get(e.dxf.layer, 0) + 1
    return summary
