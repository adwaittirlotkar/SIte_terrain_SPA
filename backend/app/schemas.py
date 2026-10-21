from typing import List, Optional, Dict, Any
from pydantic import BaseModel


class BoundaryInfo(BaseModel):
    area_m2: Optional[float] = None
    perimeter_m: Optional[float] = None
    centroid: Optional[List[float]] = None
    layer: Optional[str] = None
    status: str = "NOT_FOUND"  # FOUND | NOT_FOUND | AMBIGUOUS
    corners: Optional[List[List[float]]] = None  # [[x, y], ...] local meters, for drawing the outline


class ElevationStats(BaseModel):
    min: float
    max: float
    mean: float
    range: float


class SlopeAnalysis(BaseModel):
    buildable_pct: float   # 0-10 deg (~0-18% grade) - generally straightforward to build on
    moderate_pct: float    # 10-25 deg (~18-47% grade) - buildable with grading/retaining walls
    steep_pct: float       # 25 deg+ (~47%+ grade) - difficult/costly without real engineering
    note: str = (
        "Area-weighted breakdown by slope steepness. Bands are common rule-of-thumb "
        "site-screening thresholds, not a substitute for a geotechnical assessment."
    )


class UploadResponse(BaseModel):
    project_id: str
    filename: str
    point_count: int
    face_count: int
    boundary: BoundaryInfo
    elevation: ElevationStats
    elevation_reference: str
    average_slope_percent: float
    slope_analysis: SlopeAnalysis
    layer_summary: Dict[str, int]
    warnings: List[str] = []


class SiteResponse(BaseModel):
    project_id: str
    filename: str
    point_count: int
    face_count: int
    boundary: BoundaryInfo
    elevation: ElevationStats
    elevation_reference: str
    average_slope_percent: float
    slope_analysis: SlopeAnalysis
    layer_summary: Dict[str, int]
    warnings: List[str] = []


class TerrainResponse(BaseModel):
    vertices: List[List[float]]
    faces: List[List[int]]
    elevation_min: float
    elevation_max: float
    contours: List[Dict[str, Any]] = []


class BuildingFeature(BaseModel):
    footprint: List[List[float]]  # [[x, y], ...] local meters, ground-level ring
    base_elevation: float         # real terrain elevation under the building's centroid
    height: float                 # meters, above base_elevation
    height_source: str            # "OSM_TAG" (real) | "ESTIMATED" (guessed - never silently treated as real)


class RoadFeature(BaseModel):
    points: List[List[float]]  # [[x, y, z], ...] local meters, z follows real terrain
    road_type: str              # OSM `highway` tag value, e.g. "residential", "footway"


class PlaceResponse(BaseModel):
    buildings: List[BuildingFeature]
    roads: List[RoadFeature]
    warnings: List[str] = []
