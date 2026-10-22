"""FastAPI backend -- accurate 3D terrain viewer pipeline.

Accuracy contract:
- Elevations are float64 end-to-end (DXF -> API -> Three.js Float64Array).
- No vertical exaggeration by default (frontend defaults to 1.0).
- Slope coloring uses true surface normals, not the exaggerated mesh.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import uuid

import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware

from .dxf_parser import parse_dxf
from .tin import build_tin, compute_stats, dynamic_contour_interval
from .contours import extract_contours
from .ground import sample_ground

DATA_DIR = os.environ.get("SITE_DATA_DIR", os.path.join(os.getcwd(), "data", "projects"))
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB hard limit

app = FastAPI(title="SPA Site Intelligence (accuracy build)")

ALLOWED_ORIGINS = [o for o in os.environ.get(
    "SITE_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o]
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])


def _project_dir(pid: str) -> str:
    d = os.path.join(DATA_DIR, pid)
    os.makedirs(d, exist_ok=True)
    return d


@app.get("/api/health")
def health():
    return {"ok": True}


MAX_IFC_BYTES = 100 * 1024 * 1024  # 100 MB BIM models


@app.post("/api/building/{pid}")
async def upload_building(pid: str, file: UploadFile = File(...)):
    """Tessellate an IFC building model to a flat mesh for terrain preview.

    Returns vertices/triangles in model-local metres (Z-up) plus its bbox so
    the viewer can anchor the base onto the sampled ground elevation.
    """
    if not file.filename or not file.filename.lower().endswith((".ifc", ".xifc")):
        raise HTTPException(400, "Only .ifc BIM models are supported.")
    raw = await file.read()
    if len(raw) > MAX_IFC_BYTES:
        raise HTTPException(413, f"IFC exceeds {MAX_IFC_BYTES // (1024*1024)} MB limit.")
    if not os.path.isdir(os.path.join(DATA_DIR, pid)):
        raise HTTPException(404, f"Unknown site {pid}. Upload a survey first.")
    try:
        from .building import extract_ifc_mesh
        mesh = extract_ifc_mesh(raw)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except ImportError:
        raise HTTPException(501, "IFC support not installed (pip install ifcopenshell).")
    except Exception as e:
        raise HTTPException(400, f"Failed to read IFC: {e}")
    mesh["name"] = file.filename
    # Ground-conformance data: base elevation at model centre + per-corner
    # samples so the viewer can drop/tilt the building onto the real TIN.
    try:
        with open(os.path.join(DATA_DIR, pid, "tin.json")) as f:
            tin = json.load(f)
        cx = 0.5 * (mesh["bbox"]["min"][0] + mesh["bbox"]["max"][0])
        cy = 0.5 * (mesh["bbox"]["min"][1] + mesh["bbox"]["max"][1])
        lo, hi = mesh["bbox"]["min"], mesh["bbox"]["max"]
        corners = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]
        mesh["ground"] = sample_ground(
            np.asarray(tin["points_xy"]), np.asarray(tin["z"]),
            np.asarray(tin["simplices"]), corners + [[cx, cy]])
    except Exception:
        pass
    with open(os.path.join(_project_dir(pid), "building.json"), "w") as f:
        json.dump(mesh, f)
    return mesh


@app.post("/api/cut-fill/{pid}")
async def cut_fill_endpoint(pid: str, body: dict):
    """Cut/fill volumes between a flat platform level and the site TIN."""
    from .ground import cut_fill as _cf
    d = os.path.join(DATA_DIR, pid)
    if not os.path.isdir(d):
        raise HTTPException(404, f"Unknown site {pid}.")
    ring = body.get("ring")
    level = float(body.get("level", 0.0))
    cell = float(body.get("cell_m", 1.0))
    if not ring or len(ring) < 3:
        raise HTTPException(422, "Provide a closed footprint ring of >=3 [x,y] points.")
    cell = min(max(cell, 0.25), 10.0)
    with open(os.path.join(d, "tin.json")) as f:
        tin = json.load(f)
    return _cf(np.asarray(tin["points_xy"]), np.asarray(tin["z"]),
               np.asarray(tin["simplices"]), ring, level, cell)


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".dxf"):
        raise HTTPException(400, "Only .dxf land surveys are supported.")
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_BYTES // (1024*1024)} MB limit.")

    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    try:
        parsed = parse_dxf(tmp_path)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(400, f"Failed to read DXF: {e}")
    finally:
        os.unlink(tmp_path)

    tin = build_tin(parsed.points)
    stats = compute_stats(tin)
    pid = uuid.uuid4().hex[:12]
    # Persist the TIN so BIM placement (/api/building/{pid}) and cut/fill can
    # sample real ground elevations without re-parsing the DXF.
    with open(os.path.join(_project_dir(pid), "tin.json"), "w") as f:
        json.dump({
            "points_xy": np.asarray(tin["points_xy"]).tolist(),
            "z": np.asarray(tin["z"]).tolist(),
            "simplices": np.asarray(tin["simplices"]).tolist(),
        }, f)
    interval = dynamic_contour_interval(stats)
    levels = [math.ceil(stats["min_elev"] / interval) * interval + i * interval
              for i in range(int(math.floor(stats["relief"] / interval)) + 1)]
    contours = extract_contours(tin["points_xy"], tin["z"], tin["simplices"], levels)

    boundary = _boundary_from_tin(tin)
    area, perimeter = _area_perimeter(boundary)

    payload = {
        "id": pid,
        "name": file.filename,
        "units_hint": parsed.units_hint,
        "warnings": parsed.warnings,
        "layers": parsed.layers,
        "skipped_layers": parsed.skipped_layers,
        "stats": stats,
        "contour_interval": interval,
        "contours": contours,
        "boundary": boundary,
        "area_m2": area,
        "perimeter_m": perimeter,
    }
    with open(os.path.join(_project_dir(pid), "site.json"), "w") as f:
        json.dump(payload, f)
    return payload


@app.post("/api/fetch-location")
async def fetch_location(body: dict):
    """Build a terrain model from real Copernicus GLO-30 elevation data.

    The user picks a point on the satellite map in the frontend; we sample a
    DEM grid around it, convert it to survey-style points (local metres,
    float64 elevations) and run the SAME TIN/contour/boundary pipeline used
    for DXF uploads -- so both input paths produce identical output shapes.
    """
    polygon = body.get("polygon")  # optional [[lat, lon], ...] drawn by user
    try:
        lat = float(body.get("lat"))
        lon = float(body.get("lon"))
    except (TypeError, ValueError):
        raise HTTPException(422, "Provide numeric lat and lon.")
    if not (-89 < lat < 90 and -180 < lon < 180):
        raise HTTPException(422, "lat must be in (-90, 90), lon in (-180, 180).")
    half_m = min(max(float(body.get("half_m", 150.0)), 30.0), 1000.0)

    use_polygon = isinstance(polygon, list) and len(polygon) >= 3
    from .dem import fetch_grid, fetch_grid_for_polygon
    try:
        if use_polygon:
            polygon = [[float(a), float(b)] for a, b in polygon]
            grid = fetch_grid_for_polygon(polygon)
        else:
            grid = fetch_grid(lat, lon, half_m=half_m)
    except ImportError:
        raise HTTPException(501, "DEM support not installed (pip install rasterio mercantile).")
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(502, f"Could not fetch elevation data: {e}")

    # reproject lon/lat -> local ENU metres about the picked centre
    lons = np.asarray(grid["lons"], dtype=np.float64)
    lats = np.asarray(grid["lats"], dtype=np.float64)
    elev = np.asarray(grid["elev"], dtype=np.float64)
    x = (lons - lon) * 111_320.0 * math.cos(math.radians(lat))
    y = (lats - lat) * 111_320.0

    if use_polygon and "mask" in grid:
        # keep only samples inside the drawn polygon -> terrain matches the draw
        m = np.asarray(grid["mask"], dtype=bool) & np.isfinite(elev)
        if m.sum() < 10:
            raise HTTPException(422, "Drawn polygon is too small — zoom in and draw a larger plot.")
        X, Y, Z = x[m], y[m], elev[m]
        # add the exact polygon corners (elevations sampled from DEM) so the
        # boundary follows the drawn outline precisely
        plons = np.array([p[1] for p in polygon]); plats = np.array([p[0] for p in polygon])
        px = (plons - lon) * 111_320.0 * math.cos(math.radians(lat))
        py = (plats - lat) * 111_320.0
        # sample corner elevations from the nearest interior points
        from scipy.interpolate import griddata
        corner_z = griddata(np.stack([X, Y], axis=1), Z,
                            np.stack([px, py], axis=1), method="nearest")
        X = np.concatenate([X, px]); Y = np.concatenate([Y, py])
        Z = np.concatenate([Z, np.where(np.isfinite(corner_z), corner_z, np.median(Z))])
        pts = np.stack([X, Y, Z], axis=1)
        site_name = f"Satellite site ({lat:.4f}, {lon:.4f}) — drawn polygon"
    else:
        pts = np.stack([x, y, elev], axis=1)
        site_name = f"Satellite site ({lat:.4f}, {lon:.4f})"
    tin = build_tin(pts)
    stats = compute_stats(tin)
    pid = uuid.uuid4().hex[:12]
    with open(os.path.join(_project_dir(pid), "tin.json"), "w") as f:
        json.dump({
            "points_xy": np.asarray(tin["points_xy"]).tolist(),
            "z": np.asarray(tin["z"]).tolist(),
            "simplices": np.asarray(tin["simplices"]).tolist(),
        }, f)
    interval = dynamic_contour_interval(stats)
    levels = [math.ceil(stats["min_elev"] / interval) * interval + i * interval
              for i in range(int(math.floor(stats["relief"] / interval)) + 1)]
    contours = extract_contours(tin["points_xy"], tin["z"], tin["simplices"], levels)
    boundary = _boundary_from_tin(tin)
    area, perimeter = _area_perimeter(boundary)

    payload = {
        "id": pid,
        "name": site_name,
        "source": "copernicus_glo30",
        "units_hint": "m",
        "warnings": [
            "Elevation from Copernicus GLO-30 DEM (~30 m resolution) -- "
            "good for feasibility-level visualisation, not survey-grade.",
            "Vertical datum is height above sea level (MSL-equivalent).",
        ],
        "layers": ["DEM"],
        "skipped_layers": [],
        "stats": stats,
        "contour_interval": interval,
        "contours": contours,
        "boundary": boundary,
        "area_m2": area,
        "perimeter_m": perimeter,
        "centre_lat": lat,
        "centre_lon": lon,
    }
    with open(os.path.join(_project_dir(pid), "site.json"), "w") as f:
        json.dump(payload, f)
    return payload


def _boundary_from_tin(tin) -> list[list[float]]:
    """Edge-aware site boundary.

    Uses the actual TIN edges (faces surviving slope pruning): a boundary
    edge belongs to exactly one triangle, so walking the connected chain of
    such edges traces the REAL site outline -- including concavities and
    gaps -- instead of a convex hull that fabricates ground over areas with
    no survey points. Falls back to the convex hull only if the walk fails.
    """
    xy = tin["points_xy"]
    simplices = tin["simplices"]
    if len(xy) < 3 or len(simplices) == 0:
        return _convex_boundary(xy)
    try:
        # Vectorised: an edge shared by two faces appears twice in the stacked
        # sorted-edge array; boundary edges appear exactly once.
        import numpy as np
        e = np.concatenate([
            np.sort(simplices[:, [0, 1]], axis=1),
            np.sort(simplices[:, [1, 2]], axis=1),
            np.sort(simplices[:, [2, 0]], axis=1),
        ], axis=0)
        uniq, counts = np.unique(e, axis=0, return_counts=True)
        bnd_edges = uniq[counts == 1]
        if len(bnd_edges) < 3:
            return _convex_boundary(xy)
        from collections import defaultdict
        adj = defaultdict(list)
        for a, b in bnd_edges.tolist():
            adj[a].append(b)
            adj[b].append(a)
        loops: list[list[int]] = []
        seen_edges: set[tuple[int, int]] = set()
        for v0 in list(adj):
            for w in adj[v0]:
                if (min(v0, w), max(v0, w)) in seen_edges:
                    continue
                # Greedy loop walk through degree-2 chains.
                loop = [v0]
                prev, cur = v0, w
                guard = 0
                while cur != v0 and guard <= len(adj):
                    guard += 1
                    loop.append(cur)
                    seen_edges.add((min(prev, cur), max(prev, cur)))
                    nxts = [n for n in adj[cur] if n != prev]
                    if not nxts:
                        break
                    prev, cur = cur, nxts[0]
                seen_edges.add((min(prev, cur), max(prev, cur)))
                if cur == v0 and len(loop) >= 3:
                    loops.append(loop)
        if not loops:
            return _convex_boundary(xy)
        # Keep every closed loop (outer + inner rings); area/perimeter uses
        # the largest signed-area ring(s) via shapely downstream.
        def shoelace2(loop):
            pts_ = xy[loop]
            x_ = pts_[:, 0]; y_ = pts_[:, 1]
            return abs(float(np.dot(x_, np.roll(y_, -1)) - np.dot(y_, np.roll(x_, -1))))
        best = max(loops, key=shoelace2)
        return [[float(xy[i][0]), float(xy[i][1])] for i in best]
    except Exception:
        return _convex_boundary(xy)


def _convex_boundary(xy) -> list[list[float]]:
    from scipy.spatial import ConvexHull
    if len(xy) < 3:
        return []
    try:
        h = ConvexHull(xy)
        return [[float(xy[i][0]), float(xy[i][1])] for i in h.vertices]
    except Exception:
        return []


def _area_perimeter(poly):
    if not poly:
        return None, None
    try:
        from shapely.geometry import Polygon
        p = Polygon(poly)
        if not p.is_valid:
            p = p.buffer(0)
        return p.area, p.length
    except Exception:
        return None, None
