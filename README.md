# SPA Site Intelligence — v1 (Site Survey → Digital Site Model)

Two ways to get an interactive 3D terrain model in the browser:

1. **Upload a DXF land survey** — TIN mesh, elevation stats, slope,
   contours, and site boundary area/perimeter, all computed
   deterministically from real surveyed X/Y/Z points.
2. **Pick a real location on a satellite map** — draw a box anywhere on
   Earth and get back a real terrain model built from free public
   elevation data (Copernicus GLO-30), no survey file needed.

No AI in this version, by design (see section 15 of the original plan:
get the math trustworthy first).

```
survey.dxf ──────────────────┐
                              ├─→ TIN (Delaunay) → Three.js terrain → stats panel
map selection → Copernicus DEM ┘
```

## Project layout

```
site-model-project/
├── backend/                 FastAPI service
│   ├── app/
│   │   ├── main.py             API routes (upload / fetch-location / site / terrain / place / hillshade)
│   │   ├── dxf_parser.py       Pulls X/Y/Z points + boundary candidates from DXF
│   │   ├── elevation_source.py Fetches real elevation from Copernicus DEM (AWS Open Data)
│   │   ├── osm_source.py       Fetches real buildings/roads from OpenStreetMap (Place mode)
│   │   ├── groundwater_source.py  Real CGWB well data via India's National Water Data Portal
│   │   ├── terrain.py          Delaunay TIN, elevation stats, slope, contours
│   │   ├── geometry.py         Boundary area/perimeter (Shapely)
│   │   ├── storage.py          File-based project storage
│   │   └── schemas.py          Pydantic response models
│   ├── sample_data/
│   │   └── generate_sample_dxf.py   Makes a synthetic test parcel
│   ├── data/projects/       Created at runtime — one folder per upload
│   └── requirements.txt
│
└── frontend/                 React + TypeScript + Three.js
    └── src/
        ├── App.tsx
        ├── api.ts             Fetch wrapper for the backend
        ├── types.ts
        └── components/
            ├── UploadPanel.tsx     DXF drag-and-drop entry point
            ├── LocationPicker.tsx  Leaflet satellite map, drag-to-select a real area
            ├── Sidebar.tsx         Stats, elevation legend, layer list
            ├── TerrainViewer.tsx   Three.js scene: TIN mesh, contours, shadows, compass,
            │                       scale bar, measure tool, hillshade texture, Place buildings/roads
            ├── ViewToolbar.tsx     Color mode, view presets, measure toggle, Terrain/Place toggle
            └── StatusBar.tsx       Live X/Y/Z coordinate readout on hover
```

## Running it

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Windows / PowerShell notes:**
- PowerShell doesn't accept `&&` as a command separator — use `;` or run
  each command on its own line (e.g. `cd backend` then `pip install ...`
  as separate commands, not `cd backend && pip install ...`).
- If `pip install` tries to **build numpy/scipy from source** (you'll see
  `meson setup` output and eventually an error about missing `gfortran`
  / `ifort`), it means pip couldn't find a prebuilt wheel for your Python
  version — this happens on very new Python releases (3.13+/3.14) before
  the scientific Python packages have published wheels for them. Two
  fixes, either works:
  - **Easiest:** install Python 3.11 or 3.12 alongside your current
    Python, then create the venv with that version specifically, e.g.
    `py -3.12 -m venv venv` on Windows, and reinstall.
  - Or install a recent Microsoft C++ Build Tools + a Fortran compiler
    (e.g. via `conda install scipy` instead of pip, which ships prebuilt
    binaries and sidesteps this entirely).
- `rasterio` (used for the map-picker feature) is a similarly heavy
  compiled package. If it fails to install the same way scipy did,
  the same fix applies (a Python version pip has wheels for; check
  the error message for which version it's missing).

The API is now at `http://localhost:8000`. Check `http://localhost:8000/api/health`.

Don't have a real survey file yet? Generate a synthetic one:

```bash
cd backend/sample_data
python3 generate_sample_dxf.py     # writes sample.dxf
```

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, drop in `sample.dxf` (or a real survey), and
you should see a 3D terrain appear with the stats panel populated.

The dev server proxies `/api/*` to `localhost:8000` (see `vite.config.ts`),
so no CORS config is needed locally beyond what's already in `main.py`.

## What v1 actually does

- Parses `POINT`, `LWPOLYLINE`, `POLYLINE`, `3DFACE`, and `LINE` entities
  out of a DXF file's modelspace.
- Builds a TIN (Triangulated Irregular Network) via Delaunay triangulation
  over the XY plane, carrying the real Z values through.
- Computes elevation min/max/mean/range and per-face slope → average
  slope percentage, entirely with NumPy — no model, no inference.
- Looks for a closed `LWPOLYLINE` to use as the site boundary and
  computes area/perimeter with Shapely. If there are multiple candidates,
  it picks the one with the most vertices **and says so** in the response
  (`boundary.status = "AMBIGUOUS"`) rather than pretending it's certain.
- Extracts contour lines with a small marching-triangles implementation.
- Renders all of it in Three.js: vertex-colored terrain, a wireframe
  overlay so it still reads as a survey mesh, contour lines, real-time
  shadows, and a CAD-style live coordinate readout in the status bar
  when you hover the model.

## Viewport controls

- **Color by Elevation / Slope** (top-left toolbar) — Elevation is the
  teal-to-amber tint. Slope colors each point by how steep the ground is
  there (green = flatter/likely buildable, red = 35°+ steep) — since this
  project is aimed at small-area site development, this mode is meant to
  answer "where on this site could I actually build" directly, not just
  "what does it look like."
- **View presets** (Iso / Top / Side) — jumps the camera to a standard
  angle without resetting your color mode.
- **Compass + scale bar** (bottom-left) — the scale bar is deliberately
  labeled "approx." — it's computed from the perspective camera's
  current distance/FOV at the view center, so it drifts slightly toward
  the edges of the view, same as any perspective 3D scene. Good for a
  visual sense of size, not a substitute for the exact area/perimeter
  numbers in the sidebar.
- **Vertical exaggeration slider** (top-right) — real elevation change is
  often a small fraction of a site's horizontal span, especially for
  map-picked locations (hundreds of meters wide, tens of meters of real
  relief) — at true 1:1 scale that reads as visually flat even though
  the data is completely correct. A sensible default is auto-computed
  per site; the slider only ever affects the *visual* mesh — hover
  readouts, measurements, and the sidebar stats always show true,
  un-exaggerated elevation.
- **Measure tool** (📏 in the toolbar) — click two points on the terrain
  to get horizontal distance, elevation change, direct (3D) distance, and
  slope % between them, computed from true un-exaggerated coordinates
  regardless of the exaggeration slider's current setting. Click a third
  time to start a new measurement. This is aimed squarely at the
  small-area precision use case — checking real distances and grades
  directly on the model rather than eyeballing it. Markers/lines always
  render on top of everything else in the scene (buildings included) -
  a marker landing behind opaque building geometry used to look
  indistinguishable from the click not registering at all.
- **Close-zoom camera limits** — the camera's near clipping plane and
  minimum zoom distance both scale down for small sites, so you can
  actually zoom in tight on a small plot without clipping through the
  surface (the default camera settings that work fine for a city block
  clip badly on a 30m-wide site).

## A note on precision

This project's stated goal is **precise terrain for small-area
development** — worth being direct about what actually delivers on that
versus what's a useful approximation:

- **The DXF survey path is the precise one.** Real surveyed X/Y/Z data,
  computed deterministically, no interpolation guesswork. This is the
  path to trust for anything where precision actually matters.
- **The "Pick a Real Location" map path is context/massing, not
  precision** — free satellite DEMs (Copernicus GLO-30/90) are 30-90m
  resolution. For a small plot, that can mean only a handful of real
  data points across the *entire* site. It's genuinely useful for
  seeing a location's general shape before you have a survey, or for
  larger sites where 30-90m starts to actually resolve real features —
  it should not be treated as survey-grade for a small parcel.
- If real small-area precision is needed without a formal ground survey,
  **drone photogrammetry** is worth knowing about as an option — it's
  become genuinely affordable, and produces real cm-level point clouds
  that could feed this exact same pipeline (same shape of input as a
  DXF survey: real X/Y/Z points, not modeled/interpolated ones).

## Pick a Real Location

On the landing screen, switch to the **"Pick a Real Location"** tab. It
opens a satellite map (Esri World Imagery, via Leaflet — no API key, no
account needed for the map itself). Type coordinates into "Jump to" to
center on your area of interest, then **click and drag** on the map to
draw a rectangle. Click **"Generate 3D Terrain"** and it:

1. Figures out which 1°×1° Copernicus DEM tile(s) your rectangle falls
   into, and downloads them from `copernicus-dem-30m.s3.amazonaws.com`
   (the public AWS Open Data bucket — **no API key or account required**).
   Tiles are cached locally after the first download.
2. Mosaics tiles together if your selection straddles more than one, and
   crops to exactly your selected rectangle.
3. Projects every sample point from lat/lon into local flat meters
   (a simple equirectangular approximation centered on your selection —
   accurate to a small fraction of a percent for anything up to a few km
   across, which covers any realistic single-site selection).
4. Feeds those points into the **exact same** `terrain.build_tin()`
   pipeline the DXF path uses — nothing downstream changes.

**Data source honesty, worth reading before you trust the numbers:**

- **Resolution is ~30m.** Fine for a hillside, a neighborhood, a city
  block — genuinely coarse for a small residential plot (you may only
  get a handful of sample points across a small site).
- **It's a Digital *Surface* Model, not bare earth.** In wooded or
  built-up areas, it measures the top of tree canopy or rooftops, not
  the ground underneath.
- **Elevation is relative to the EGM2008 geoid** (global mean sea
  level), not any local survey benchmark — don't expect these numbers
  to match a local surveyor's numbers directly.
- Good for context, massing studies, and "what does this hillside
  generally look like" — not a substitute for real survey data if
  precision matters.

**Surface vs. Bare-earth toggle:** before generating, pick between:
- **Surface** — Copernicus DEM direct, the default described above.
- **Bare-earth** — [FABDEM](https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn)
  (Forest And Buildings-removed Copernicus DEM, University of Bristol).
  Same underlying 30m grid, same resolution — but ML-corrected to strip
  out tree canopy and rooftop height, giving true ground level instead of
  "top of whatever's standing there." Genuinely more accurate on wooded
  or built-up sites; **not** a resolution upgrade, since it's still
  30m — see `elevation_source.fetch_elevation_grid_bare_earth()`.
  Distributed via a smaller, community-maintained public source rather
  than Copernicus's official AWS Open Data hosting, so if it fails
  repeatedly, "Surface" is the more reliably-hosted fallback.

**Swapping data sources later:** `elevation_source.py` is deliberately
the *only* file that knows where elevation data comes from. If you ever
want to switch to OpenTopography's API (rate-limited but keeps a wider
range of datasets, including some higher-resolution regional ones) or
add another source, that's the one file to change — `main.py`,
`terrain.py`, and the whole frontend don't care where the points came
from.

## Groundwater: real measured data, not computed

This project will **never** compute or estimate a groundwater / water-table
depth from elevation data. Subsurface water depth depends on rock and soil
layers, aquifer boundaries, and geology — none of which is visible in
surface elevation data. There is no legitimate calculation that turns "the
shape of this hill" into "how deep is the water underground," and
fabricating one would risk informing a real bad decision (where to dig a
well, whether a basement will flood) with a confidently-wrong number.

Instead, `groundwater_source.py` queries **real measured data**: India's
[National Water Data Portal](https://nwdp.nwic.gov.in) (run by NWIC,
Ministry of Jal Shakti - a real government CKAN instance, confirmed live),
serving actual quarterly manual readings from CGWB's monitoring well
network. For a location-fetched site, it finds the **nearest real
monitoring well** and returns its actual measured depth-to-water and
reading history - never a value invented for your exact site.

**This is honestly, unavoidably limited, not a bug:**
- **State coverage is minimal on purpose.** Only `Maharashtra` has a
  confirmed, verified CKAN `resource_id` in `STATE_RESOURCES` right now.
  Everywhere else returns `available: false` - a normal, expected result,
  not an error - rather than silently returning nothing or (worse)
  guessing at a resource ID the way the DEM tile-naming mistake almost
  did earlier in this project. Adding a state means finding and
  confirming its real resource_id first (see `nwdp.nwic.gov.in`'s
  "Ground Water Level (Manual - Quarterly), Central Ground Water Board"
  dataset), not adding a name to a list speculatively.
- **The nearest well may be far from your site.** In sparsely-monitored
  areas this could be tens of kilometers away. The distance is always
  shown, and the accompanying note says so explicitly every time -
  groundwater depth can genuinely vary over even a few hundred meters
  depending on local geology, so treat this as regional context, not a
  site-specific measurement.
- **State detection is a rough bounding box** (`STATE_BBOXES`), not a real
  administrative boundary lookup - fine for deciding which dataset to
  attempt, not precise right at a state border.
- Confirmed live field names and formats (as of the date in
  `groundwater_source.py`'s docstring) directly against a real API
  response - including the date format (`DD-MM-YYYY`, confirmed
  unambiguous from a record with day=21) and that the depth value is
  below-ground-surface (consistent with the sample values seen, which
  are implausible under any other interpretation). If NWIC ever changes
  their schema, that docstring is the place to check first.

Rendered as a real 3D marker too - a thin rod from the terrain surface
down to the real measured depth, at the well's actual real-world location
relative to your site (not centered on your site - if the well is 15km
away, the marker renders 15km away, honestly). Drawn "through" the
terrain (depth-testing off) since the entire point is showing what's
below the visible surface.

## Place mode: real buildings and roads

Only available for terrain fetched via **Pick a Real Location** (DXF surveys
have no real-world lat/lon for OpenStreetMap to look up against). Toggle
**Terrain / Place** in the toolbar - Place mode drapes real OSM buildings
and roads on top of the same terrain you're already looking at.

**What's real vs. estimated, stated plainly (see `osm_source.py`):**
- Building **positions and footprints** are always real OSM data.
- Building **heights** come from OSM's `height` tag when present (shown in
  a warm stone color) - trust these. When only `building:levels` exists,
  height is *estimated* as levels × 3m (shown in cool gray) - a common
  assumption, not a measurement. When neither tag exists, height falls
  back to a flat default (also gray) - genuinely just a guess so the
  building isn't invisible, not real data.
- Buildings modeled as complex multipolygon relations (e.g. ones with a
  courtyard hole) are **skipped, not approximated** - reported in the
  response's `warnings`, not silently drawn wrong.
- Every building/road point's elevation comes from the terrain you already
  fetched (nearest real TIN vertex), not from OSM (which has no elevation
  at all) - so they sit on the actual terrain shape.
- Roads are drawn as real-width ribbons (not thin lines), sized and styled
  by their actual OSM `highway` tag - a wide bright ribbon for a primary
  road, a thin dim one for a footpath - not modeling exact real-world
  pavement width, but no longer "just a line" either.
- Your actual selected/surveyed boundary is drawn as a highlighted teal
  outline, draped onto real terrain height at each corner - so it's
  visually obvious which building cluster is your site versus the
  surrounding OSM context returned by the same bounding-box query.

## DWG files

DXF only in v1, on purpose (see the original architecture notes — DWG is
a proprietary format that ezdxf can't read directly). To use a DWG survey:

- **Have AutoCAD?** Open it and "Save As" DXF.
- **No AutoCAD?** Use a free converter such as the ODA File Converter
  (https://www.opendesign.com/guestfiles/oda_file_converter) or QCAD.
- Once you have real SPA survey data flowing through this reliably, the
  next step is wiring one of these conversion paths into the upload
  endpoint directly so users never have to think about it.

## Known limitations (intentional, for v1)

- **Storage is per-project folders on disk**, not a database. Fine for a
  prototype; move to PostgreSQL + PostGIS once there are actual spatial
  queries to run across projects (search, overlap detection, etc.).
- **Boundary detection is single-signal** (closed LWPOLYLINE only). A
  boundary drawn as a `POLYLINE` or reconstructed from disconnected
  `LINE` segments won't be picked up yet.
- **No auth, no multi-user concerns** — this is a local prototype.
- **Large surveys**: Delaunay triangulation over the full point cloud is
  O(n log n) and fine into the tens of thousands of points, but very
  dense LiDAR-scale surveys would want a decimation step before
  triangulating.

## Roadmap (from the original plan, in order)

1. ✅ DXF upload → TIN → interactive 3D terrain (this repo)
2. ✅ Real-location terrain via a satellite map picker + Copernicus DEM (this repo)
3. ✅ Buildings and roads via OpenStreetMap - "Place" mode (this repo)
4. ✅ Real groundwater data (nearest known CGWB well, Maharashtra only for
   now) - explicitly not computed, real government data only (this repo)
5. Cut/fill volume calculations between two terrain surfaces
6. Sun/shadow analysis
7. Seamless DWG handling (ODA integration or conversion pipeline baked in)
8. Optional swap to OpenTopography or a higher-res regional DEM for areas
   where one is available, without touching anything outside
   `elevation_source.py`
9. Expand groundwater state coverage - one confirmed `resource_id` at a
   time, per `groundwater_source.py`'s documented process, never guessed
10. ML-assisted classification for messy/non-standard CAD layers — always
    labeled `INFERRED` with a confidence score, never presented as verified
11. Connect to the FSI / regulatory system
