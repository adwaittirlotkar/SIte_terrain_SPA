import tempfile
import uuid
import os

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import dxf_parser, terrain, geometry, storage, elevation_source, osm_source, groundwater_source
from .schemas import UploadResponse, SiteResponse, TerrainResponse, BoundaryInfo, ElevationStats, PlaceResponse

app = FastAPI(title="SPA Site Intelligence API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten before this leaves your laptop
    allow_methods=["*"],
    allow_headers=["*"],
)


class LocationRequest(BaseModel):
    south: float
    north: float
    west: float
    east: float
    dem_source: str = "surface"  # "surface" (Copernicus) or "bare_earth" (FABDEM)


def _finalize_terrain(
    project_id: str,
    filename: str,
    points: list,
    boundary_info: BoundaryInfo,
    warnings: list,
    layer_summary: dict,
    elevation_reference: str,
) -> UploadResponse:
    """Shared by both input paths (DXF upload and map location fetch):
    build the TIN, compute stats, persist, and shape the response."""
    try:
        vertices, faces = terrain.build_tin(points)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    elevation = terrain.elevation_stats(points)
    avg_slope = terrain.average_slope_percent(vertices, faces)
    slope_analysis = terrain.slope_area_breakdown(vertices, faces)
    contours = terrain.contour_lines(vertices, faces, interval=max(elevation["range"] / 10, 0.1))

    storage.save_json(project_id, "terrain", {
        "vertices": vertices,
        "faces": faces,
        "elevation_min": elevation["min"],
        "elevation_max": elevation["max"],
        "contours": contours,
    })
    site_data = {
        "project_id": project_id,
        "filename": filename,
        "point_count": len(points),
        "face_count": len(faces),
        "boundary": boundary_info.model_dump(),
        "elevation": elevation,
        "elevation_reference": elevation_reference,
        "average_slope_percent": avg_slope,
        "slope_analysis": slope_analysis,
        "layer_summary": layer_summary,
        "warnings": warnings,
    }
    storage.save_json(project_id, "site", site_data)
    return UploadResponse(**site_data)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload", response_model=UploadResponse)
async def upload_survey(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".dxf"):
        raise HTTPException(
            status_code=400,
            detail="Only .dxf files are supported in v1. Convert DWG to DXF first "
                   "(see README for options).",
        )

    content = await file.read()
    project_id = str(uuid.uuid4())
    warnings = []

    # Write to a temp path for ezdxf to read, then archive the original.
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        try:
            points = dxf_parser.extract_survey_points(tmp_path)
            layer_summary = dxf_parser.layer_summary(tmp_path)
            boundary_candidates = dxf_parser.find_boundary_candidates(tmp_path)
        except dxf_parser.DxfParseError as e:
            raise HTTPException(status_code=422, detail=str(e))

        if len(points) < 3:
            raise HTTPException(
                status_code=422,
                detail=f"Only found {len(points)} usable coordinate points in this file. "
                       f"Need at least 3 to build a terrain model.",
            )

        boundary_info = BoundaryInfo()
        if len(boundary_candidates) == 1:
            b = boundary_candidates[0]
            analysis = geometry.analyze_boundary(b["points"])
            boundary_info = BoundaryInfo(
                area_m2=analysis["area_m2"],
                perimeter_m=analysis["perimeter_m"],
                centroid=analysis["centroid"],
                layer=b["layer"],
                status="FOUND",
                corners=[list(p) for p in b["points"]],
            )
        elif len(boundary_candidates) > 1:
            # Pick the largest by vertex count as a best guess, but say so honestly.
            best = max(boundary_candidates, key=lambda c: c["vertex_count"])
            analysis = geometry.analyze_boundary(best["points"])
            boundary_info = BoundaryInfo(
                area_m2=analysis["area_m2"],
                perimeter_m=analysis["perimeter_m"],
                centroid=analysis["centroid"],
                layer=best["layer"],
                status="AMBIGUOUS",
                corners=[list(p) for p in best["points"]],
            )
            warnings.append(
                f"Found {len(boundary_candidates)} closed polylines that could be the site "
                f"boundary. Used the layer '{best['layer']}' (most vertices) as a best guess - "
                f"verify this against the source drawing."
            )
        else:
            warnings.append(
                "No closed polyline found to use as a site boundary. Area/perimeter are unavailable; "
                "the terrain model itself is still built from the raw survey points."
            )

        # Archive the original upload for traceability.
        storage.save_original_file(project_id, file.filename, content)

        return _finalize_terrain(
            project_id, file.filename, points, boundary_info, warnings, layer_summary,
            elevation_reference=(
                "Survey's own reference datum, as recorded by the surveyor - not confirmed as "
                "mean sea level unless stated on the source drawing itself."
            ),
        )

    finally:
        os.unlink(tmp_path)


@app.post("/api/fetch-location", response_model=UploadResponse)
def fetch_location(req: LocationRequest):
    """
    Real-world terrain for a map-picked area, via the free/keyless
    Copernicus GLO-30 DEM on AWS Open Data. See elevation_source.py for
    the data-source details and known accuracy caveats.
    """
    try:
        if req.dem_source == "bare_earth":
            grid = elevation_source.fetch_elevation_grid_bare_earth(req.south, req.north, req.west, req.east)
        else:
            grid = elevation_source.fetch_elevation_grid(req.south, req.north, req.west, req.east)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except elevation_source.ElevationFetchError as e:
        raise HTTPException(status_code=422, detail=str(e))

    points, origin = elevation_source.to_local_points(grid["lats"], grid["lons"], grid["elevations"])

    # Boundary = the selected bbox itself, converted into the same local
    # coordinate system as the elevation points.
    corner_lats = [req.south, req.south, req.north, req.north, req.south]
    corner_lons = [req.west, req.east, req.east, req.west, req.west]
    corner_points, _ = elevation_source.to_local_points(
        corner_lats, corner_lons, [0] * 5, origin=origin
    )
    boundary_xy = [(p["x"], p["y"]) for p in corner_points]
    boundary_analysis = geometry.analyze_boundary(boundary_xy)
    boundary_info = BoundaryInfo(
        area_m2=boundary_analysis["area_m2"],
        perimeter_m=boundary_analysis["perimeter_m"],
        centroid=boundary_analysis["centroid"],
        layer="SELECTED_AREA",
        status="FOUND",
        corners=[list(p) for p in boundary_xy],
    )

    resolution_used = grid["resolution_m"]
    is_bare_earth = req.dem_source == "bare_earth"
    source_label = "FABDEM (bare-earth)" if is_bare_earth else f"Copernicus GLO-{resolution_used}"
    warnings = list(grid["warnings"])
    if is_bare_earth:
        warnings.append(
            f"Elevation sourced from FABDEM (~{resolution_used}m resolution) - the same "
            f"underlying Copernicus data as 'Surface' mode, but ML-corrected to remove tree "
            f"canopy and rooftop height, giving true bare-earth ground level. Still not "
            f"survey-grade, and distributed via a smaller community-maintained source than "
            f"Copernicus's official hosting."
        )
    else:
        warnings.append(
            f"Elevation sourced from Copernicus GLO-{resolution_used} (~{resolution_used}m resolution, "
            f"satellite-derived surface model). It measures the top of tree canopy / rooftops in "
            f"vegetated or built-up areas, not bare ground - and is not survey-grade. Good for "
            f"context and massing, not for engineering decisions."
        )

    project_id = str(uuid.uuid4())
    filename = f"location_{req.south:.4f}N_{req.west:.4f}E"
    layer_summary = {f"{'FABDEM' if is_bare_earth else f'COPERNICUS_GLO{resolution_used}'}": len(points)}

    storage.save_json(project_id, "location", {
        "south": req.south, "north": req.north, "west": req.west, "east": req.east,
        "origin_lat": origin[0], "origin_lon": origin[1],
    })

    return _finalize_terrain(
        project_id, filename, points, boundary_info, warnings, layer_summary,
        elevation_reference=(
            "Meters above mean sea level (EGM2008 geoid) - bare-earth (FABDEM), forest/building "
            "height removed." if is_bare_earth else
            "Meters above mean sea level (EGM2008 geoid) - Copernicus DEM's native vertical reference."
        ),
    )


@app.get("/api/site/{project_id}", response_model=SiteResponse)
def get_site(project_id: str):
    data = storage.load_json(project_id, "site")
    if data is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return SiteResponse(**data)


@app.get("/api/terrain/{project_id}", response_model=TerrainResponse)
def get_terrain(project_id: str):
    data = storage.load_json(project_id, "terrain")
    if data is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return TerrainResponse(**data)


@app.get("/api/place/{project_id}", response_model=PlaceResponse)
def get_place(project_id: str):
    """
    Real buildings and roads for this project's area, from OpenStreetMap -
    the "Place" mode alongside plain "Terrain". Only available for
    location-fetched terrain (a DXF survey has no real-world lat/lon to
    query OSM against). Building heights are drawn from OSM tags where
    present and clearly marked ESTIMATED where they're not (see
    osm_source.py) - never silently invented.
    """
    location = storage.load_json(project_id, "location")
    if location is None:
        raise HTTPException(
            status_code=404,
            detail="No place data available for this project. Place mode only works for "
                   "terrain fetched via 'Pick a Real Location', not DXF uploads.",
        )
    terrain_data = storage.load_json(project_id, "terrain")
    if terrain_data is None:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        place_data = osm_source.fetch_place_data(
            location["south"], location["north"], location["west"], location["east"],
            origin=(location["origin_lat"], location["origin_lon"]),
            terrain_vertices=terrain_data["vertices"],
        )
    except osm_source.OsmFetchError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return PlaceResponse(**place_data)


@app.get("/api/terrain/{project_id}/groundwater")
def get_groundwater(project_id: str):
    """
    Real, measured groundwater depth from the nearest known CGWB monitoring
    well, via India's National Water Data Portal - NOT computed from
    elevation, never estimated for a location that isn't a real station.
    Only available for location-fetched terrain, and only in regions with
    confirmed data coverage (currently Maharashtra only - see
    groundwater_source.py). A location outside coverage returns
    available=False, not an error - that's the normal, expected case almost
    everywhere until more states are added.
    """
    location = storage.load_json(project_id, "location")
    if location is None:
        raise HTTPException(
            status_code=404,
            detail="Groundwater lookup only works for terrain fetched via 'Pick a Real Location', "
                   "not DXF uploads.",
        )

    origin = (location["origin_lat"], location["origin_lon"])
    try:
        data = groundwater_source.get_nearest_groundwater_data(origin[0], origin[1])
    except groundwater_source.GroundwaterError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if data is None:
        return {
            "available": False,
            "message": "No groundwater monitoring data source is wired up for this region yet "
                       "(currently only Maharashtra is supported).",
        }

    station_point, _ = elevation_source.to_local_points(
        [data["station_lat"]], [data["station_lon"]], [0], origin=origin
    )
    return {
        "available": True,
        **data,
        "station_local_x": station_point[0]["x"],
        "station_local_y": station_point[0]["y"],
    }

