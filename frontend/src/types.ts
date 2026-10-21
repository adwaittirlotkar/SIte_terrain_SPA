export interface BBox {
  south: number;
  north: number;
  west: number;
  east: number;
  dem_source?: "surface" | "bare_earth";
}

export interface BoundaryInfo {
  area_m2: number | null;
  perimeter_m: number | null;
  centroid: [number, number] | null;
  layer: string | null;
  status: "FOUND" | "NOT_FOUND" | "AMBIGUOUS";
  corners: number[][] | null; // [[x, y], ...] local meters
}

export interface ElevationStats {
  min: number;
  max: number;
  mean: number;
  range: number;
}

export interface SlopeAnalysis {
  buildable_pct: number; // 0-10 deg - generally straightforward to build on
  moderate_pct: number;  // 10-25 deg - buildable with grading/retaining walls
  steep_pct: number;     // 25 deg+ - difficult/costly without real engineering
  note: string;
}

export interface SiteData {
  project_id: string;
  filename: string;
  point_count: number;
  face_count: number;
  boundary: BoundaryInfo;
  elevation: ElevationStats;
  elevation_reference: string;
  average_slope_percent: number;
  slope_analysis: SlopeAnalysis;
  layer_summary: Record<string, number>;
  warnings: string[];
}

export interface ContourLine {
  elevation: number;
  segments: number[][][]; // each segment: [[x,y,z],[x,y,z]]
}

export interface TerrainData {
  vertices: number[][]; // [x, y, z]
  faces: number[][]; // [i, j, k]
  elevation_min: number;
  elevation_max: number;
  contours: ContourLine[];
}

export interface BuildingFeature {
  footprint: number[][]; // [[x, y], ...] local meters
  base_elevation: number;
  height: number;
  height_source: "OSM_TAG" | "ESTIMATED";
}

export interface RoadFeature {
  points: number[][]; // [[x, y, z], ...] local meters
  road_type: string;
}

export interface PlaceData {
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  warnings: string[];
}

export interface GroundwaterReading {
  date: string;
  depth_below_ground_m: number;
}

export interface GroundwaterMineral {
  mineral: string;
  typical_range: string;
  role: string;
  source: string;
}

export interface GroundwaterQuality {
  overall_rating: string;
  hardness_class: string;
  ph_range: string;
  aquifer_type: string;
  minerals: GroundwaterMineral[];
  standards_reference: string;
  disclaimer: string;
}

export interface GroundwaterFlowDirection {
  bearing_deg: number;   // 0 = north, 90 = east, 180 = south, 270 = west
  direction_label: string;
  basis: string;
}

// Real measured data from the nearest known CGWB monitoring well - never
// computed/estimated for the exact site. `available: false` is a normal,
// expected response almost everywhere until more states are wired up.
export type GroundwaterData =
  | { available: false; message: string }
  | {
      available: true;
      station_name: string;
      district: string | null;
      station_lat: number;
      station_lon: number;
      distance_km: number;
      latest_reading: GroundwaterReading;
      recent_readings: GroundwaterReading[];
      depth_trend: "rising" | "falling" | "stable" | null;
      flow_direction: GroundwaterFlowDirection;
      water_quality: GroundwaterQuality;
      source: string;
      note: string;
      station_local_x: number;
      station_local_y: number;
    };
