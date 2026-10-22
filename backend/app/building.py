"""IFC -> flat mesh extraction for on-terrain building preview.

Deterministic geometry only (no AI). We tessellate every IfcSolidModel with
IfcOpenShell, collect triangles in IFC local coordinates (meters, Z-up),
and return them as plain JSON so the frontend can place the model onto the
TIN terrain with Float64 centering.

Elevation anchoring: the model's min-Z vertex is reported so the viewer can
drop the building base exactly onto the sampled ground elevation at its
placement point.
"""
from __future__ import annotations

import numpy as np


def extract_ifc_mesh(raw: bytes) -> dict:
    """Parse IFC bytes and return {vertices, indices, bbox, meta}.

    vertices: [[x, y, z], ...] rounded to mm, metres, model origin (Z-up)
    indices:  [[a, b, c], ...] triangle faces
    bbox:     {min:[x,y,z], max:[x,y,z], width, depth, height}
    meta:     {elements} — number of solids tessellated
    """
    import ifcopenshell
    import ifcopenshell.geom as ig
    import os
    import tempfile

    # IfcOpenShell only reads from a path or string; write to a temp file.
    fd, tmp_path = tempfile.mkstemp(suffix=".ifc")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        f = ifcopenshell.open(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    settings = ig.settings()
    try:
        settings.set("WELD_VERTICES", True)
    except Exception:
        pass

    # Normalise to metres regardless of the IFC length unit prefix.
    def _length_scale(f):
        try:
            for u in f.by_type("IfcUnitAssignment")[0].Units:
                if u.is_a("IfcSIUnit") and u.UnitType == "LENGTHUNIT":
                    pfx = getattr(u, "Prefix", None)
                    table = {"EXA": 1e9, "PETA": 1e6, "TERA": 1e3, "GIGA": 1e0,
                             "MEGA": 1e6, "KILO": 1e3, None: 1.0,
                             "DECI": 1e-1, "CENTI": 1e-2, "MILLI": 1e-3,
                             "MICRO": 1e-6, "NANO": 1e-9}
                    return table.get(str(pfx).split(".")[-1] if pfx else None, 1.0)
        except Exception:
            pass
        return 1.0

    scale = _length_scale(f)

    verts: list[list[float]] = []
    tris: list[list[int]] = []
    n_elems = 0

    for prod in f.by_type("IfcProduct"):
        if prod.ObjectPlacement is None:
            continue
        try:
            sh = ig.create_shape(settings, prod)
        except Exception:
            continue
        geo = getattr(sh, "geometry", None)
        if not geo or len(geo.verts) == 0:
            continue
        n_elems += 1
        base = len(verts)
        arr = np.asarray(geo.verts, dtype=np.float64).reshape(-1, 3) * scale
        # Round to millimetre precision — plenty for visual placement,
        # keeps the JSON payload small.
        arr = np.round(arr, 3)
        verts.extend(arr.tolist())
        faces = np.asarray(geo.faces_tri, dtype=np.int64).reshape(-1, 3)
        tris.extend((faces + base).tolist())

    if not verts:
        raise ValueError("No tessellatable solids found in this IFC file.")

    va = np.asarray(verts, dtype=np.float64)
    lo = va.min(axis=0)
    hi = va.max(axis=0)
    return {
        "vertices": verts,
        "indices": tris,
        "bbox": {
            "min": lo.tolist(),
            "max": hi.tolist(),
            "width": float(hi[0] - lo[0]),
            "depth": float(hi[1] - lo[1]),
            "height": float(hi[2] - lo[2]),
        },
        "meta": {"elements": n_elems},
    }
