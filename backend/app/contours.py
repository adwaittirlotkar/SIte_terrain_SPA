"""Marching-squares contour extraction from the TIN surface.

Contour interval is derived DYNAMICALLY from relief + point density
(see tin.dynamic_contour_interval) instead of being hard-coded, so a
flat 0.5 m lot and a 40 m hillside both stay readable.

Method: evaluate the piecewise-linear TIN on a regular grid using exact
barycentric lookup against Delaunay simplices, then trace isolines with
marching squares (proper edge interpolation) and chain segments into
polylines.
"""
from __future__ import annotations

import numpy as np


def _tin_to_grid(xy: np.ndarray, z: np.ndarray, simplices: np.ndarray,
                 grid_n: int = 512):
    """Evaluate the piecewise-linear TIN surface on a regular XY grid.

    Exact barycentric test against all triangles (no nearest-point
    approximation). Grid points are processed in chunks so the
    (chunk x triangles) arrays never blow up memory.
    """
    x0, y0 = xy.min(axis=0)
    x1, y1 = xy.max(axis=0)
    xs = np.linspace(x0, x1, grid_n)
    ys = np.linspace(y0, y1, grid_n)
    gx, gy = np.meshgrid(xs, ys)

    tri = simplices.astype(np.int64)
    p0 = xy[tri[:, 0]]; p1 = xy[tri[:, 1]]; p2 = xy[tri[:, 2]]
    v0 = p1 - p0; v1 = p2 - p0
    det = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    ok = np.abs(det) > 1e-12
    det_safe = np.where(ok, det, 1.0)
    z0 = z[tri[:, 0]]; z1 = z[tri[:, 1]]; z2 = z[tri[:, 2]]

    qx_all = gx.ravel()[:, None]
    qy_all = gy.ravel()[:, None]
    gz_flat = np.full(qx_all.shape[0], np.nan)

    # chunk over grid points so each (chunk x Mtri) float array stays < ~64 MB
    n_tri = len(tri)
    per_pt = max(n_tri * 8 * 5, 64)          # 5 float arrays of width Mtri
    chunk = max(1, int(64 * 1024 * 1024 // per_pt))
    for s in range(0, qx_all.shape[0], chunk):
        e = min(s + chunk, qx_all.shape[0])
        qx = qx_all[s:e] - p0[None, :, 0]
        qy = qy_all[s:e] - p0[None, :, 1]
        u = (qy * v1[None, :, 1] - qx * v1[None, :, 0]) / det_safe[None, :]
        v = (qx * v0[None, :, 1] - qy * v0[None, :, 0]) / det_safe[None, :]
        inside = ok[None, :] & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
        has = inside.any(axis=1)
        rows_local = np.arange(e - s)
        best = np.argmax(inside, axis=1)
        uu = u[rows_local, best]; vv = v[rows_local, best]
        zz = z0[best] * (1 - uu - vv) + z1[best] * uu + z2[best] * vv
        sel = np.arange(s, e)[has]
        gz_flat[sel] = zz[has]
    return gx, gy, gz_flat.reshape(gx.shape)


# Edge pairs keyed by which corners bound each cell edge.
_EDGE_CORNERS = {
    "bottom": ((0, 0), (1, 0)),
    "right":  ((1, 0), (1, 1)),
    "top":    ((1, 1), (0, 1)),
    "left":   ((0, 1), (0, 0)),
}
# Marching-squares cases -> list of edges to connect (bit order: bl=1 br=2 tr=4 tl=8)
_TABLE = {
    1:  [("left", "bottom")],   2:  [("bottom", "right")],
    3:  [("left", "right")],    4:  [("right", "top")],
    5:  [("left", "top"), ("bottom", "right")],
    6:  [("bottom", "top")],    7:  [("left", "top")],
    8:  [("top", "left")],      9:  [("bottom", "top")],
    10: [("bottom", "left"), ("right", "top")],
    11: [("right", "top")],     12: [("left", "right")],
    13: [("bottom", "right")],  14: [("left", "bottom")],
}


def _edge_point(name, C, X, Y, level):
    (ci, cj), (di, dj) = _EDGE_CORNERS[name]
    c1 = C[ci, cj]; c2 = C[di, dj]
    denom = c1 - c2
    t = 0.0 if abs(denom) < 1e-15 else c1 / denom
    t = min(max(t, 0.0), 1.0)
    return (float(X[ci, cj] + t * (X[di, dj] - X[ci, cj])),
            float(Y[ci, cj] + t * (Y[di, dj] - Y[ci, cj])))


def extract_contours(xy, z, simplices, levels, grid_n: int = 512) -> list[dict]:
    gx, gy, gz = _tin_to_grid(xy, z, simplices, grid_n)
    out = []
    for lv in levels:
        segs = []
        c = gz - lv
        sign = np.where(np.isnan(c), 0, (c > 0).astype(np.uint8))
        code = (sign[:-1, :-1] | (sign[1:, :-1] << 1)
                | (sign[1:, 1:] << 2) | (sign[:-1, 1:] << 3))
        valid = ~(np.isnan(gz[:-1, :-1]) | np.isnan(gz[1:, :-1])
                  | np.isnan(gz[1:, 1:]) | np.isnan(gz[:-1, 1:]))
        ii, jj = np.nonzero(valid & (code != 0) & (code != 15))
        for i, j in zip(ii.tolist(), jj.tolist()):
            idx = int(code[i, j])
            cell_c = c[i:i+2, j:j+2]
            cell_x = gx[i:i+2, j:j+2]
            cell_y = gy[i:i+2, j:j+2]
            for e1, e2 in _TABLE.get(idx, []):
                segs.append((_edge_point(e1, cell_c, cell_x, cell_y, lv),
                             _edge_point(e2, cell_c, cell_x, cell_y, lv)))
        rings = _chain(segs)
        if rings:
            out.append({"level": float(lv),
                        "rings": [[[px, py] for px, py in r] for r in rings]})
    return out


def _chain(segs, tol=1e-6):
    from collections import defaultdict
    used = [False] * len(segs)
    adj = defaultdict(list)

    def key(pt):
        return (round(pt[0] / tol), round(pt[1] / tol))

    for i, (a, b) in enumerate(segs):
        adj[key(a)].append(i)
        adj[key(b)].append(i)
    lines = []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        line = [segs[i][0], segs[i][1]]
        cur = segs[i][1]
        while True:
            nxt = next((si for si in adj[key(cur)] if not used[si]), None)
            if nxt is None:
                break
            used[nxt] = True
            a, b = segs[nxt]
            cur = b if key(a) == key(cur) else a
            line.append(cur)
        if len(line) >= 2:
            lines.append(line)
    return lines
