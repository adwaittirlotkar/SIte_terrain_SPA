import { useCallback, useRef, useState } from "react";
import { uploadSurvey, fetchLocationTerrain, getTerrain, getPlaceData, getGroundwaterData } from "./api";
import { SiteData, TerrainData, BBox, PlaceData, GroundwaterData } from "./types";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TerrainViewer, { ColorMode, TerrainViewerHandle, ViewPreset } from "./components/TerrainViewer";
import UploadPanel from "./components/UploadPanel";
import LocationPicker from "./components/LocationPicker";
import ViewToolbar from "./components/ViewToolbar";

type EntryMode = "upload" | "location";

// Real elevation change is often a small fraction of a site's horizontal
// span (this is *especially* true for map-picked locations, which tend to
// cover hundreds of meters to a couple km, versus tens of meters of real
// relief) - rendered at true 1:1 scale that reads as visually flat even
// though the underlying data is completely correct. Auto-scale so the
// relief reads as roughly 20% of the horizontal extent by default, same
// idea as the "vertical exaggeration" control in any GIS 3D viewer.
function computeDefaultExaggeration(terrain: TerrainData): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of terrain.vertices) {
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[1] > maxY) maxY = v[1];
  }
  const horizontalExtent = Math.max(maxX - minX, maxY - minY, 1e-6);
  const elevationRange = Math.max(terrain.elevation_max - terrain.elevation_min, 1e-6);
  const targetRatio = 0.2;
  const raw = (horizontalExtent * targetRatio) / elevationRange;
  return Math.min(Math.max(raw, 1), 15);
}

export default function App() {
  const [mode, setMode] = useState<EntryMode>("upload");
  const [site, setSite] = useState<SiteData | null>(null);
  const [terrain, setTerrain] = useState<TerrainData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; z: number } | null>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const [colorMode, setColorMode] = useState<ColorMode>("elevation");
  const [measureMode, setMeasureMode] = useState(false);
  const [showPlace, setShowPlace] = useState(false);
  const [placeData, setPlaceData] = useState<PlaceData | null>(null);
  const [isPlaceLoading, setIsPlaceLoading] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [groundwaterData, setGroundwaterData] = useState<GroundwaterData | null>(null);
  const viewerRef = useRef<TerrainViewerHandle>(null);

  // Set by fetch-location specifically (see main.py) - DXF uploads never get this
  // boundary layer name, so it doubles as "does this project have real lat/lon
  // (and therefore a DEM / OSM data) available" without a dedicated API field.
  const isLocationBased = site?.boundary.layer === "SELECTED_AREA";

  const loadTerrain = useCallback(async (siteData: SiteData) => {
    const terrainData = await getTerrain(siteData.project_id);
    setSite(siteData);
    setTerrain(terrainData);
    setExaggeration(computeDefaultExaggeration(terrainData));
    setColorMode("elevation");
    setShowPlace(false);
    setPlaceData(null);
    setPlaceError(null);
    setGroundwaterData(null);
    // Best-effort, silent - real coverage is currently limited to one state,
    // so "unavailable here" is the normal, expected outcome almost
    // everywhere. Never blocks or errors the main terrain load.
    if (siteData.boundary.layer === "SELECTED_AREA") {
      getGroundwaterData(siteData.project_id)
        .then(setGroundwaterData)
        .catch(() => setGroundwaterData(null));
    }
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setIsLoading(true);
      setError(null);
      try {
        const siteData = await uploadSurvey(file);
        await loadTerrain(siteData);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setIsLoading(false);
      }
    },
    [loadTerrain]
  );

  const handleLocationFetch = useCallback(
    async (bbox: BBox) => {
      setIsLoading(true);
      setError(null);
      try {
        const siteData = await fetchLocationTerrain(bbox);
        await loadTerrain(siteData);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to fetch terrain for this area");
      } finally {
        setIsLoading(false);
      }
    },
    [loadTerrain]
  );

  const handleReset = useCallback(() => {
    setSite(null);
    setTerrain(null);
    setError(null);
    setHover(null);
    setColorMode("elevation");
    setMeasureMode(false);
    setShowPlace(false);
    setPlaceData(null);
    setPlaceError(null);
    setGroundwaterData(null);
  }, []);

  const handleView = useCallback((preset: ViewPreset) => {
    viewerRef.current?.setView(preset);
  }, []);

  const handleMeasureModeChange = useCallback((v: boolean) => {
    setMeasureMode(v);
    if (!v) viewerRef.current?.clearMeasurement();
  }, []);

  const handleShowPlaceChange = useCallback(
    async (v: boolean) => {
      setShowPlace(v);
      if (v && !placeData && site) {
        setIsPlaceLoading(true);
        setPlaceError(null);
        try {
          const data = await getPlaceData(site.project_id);
          setPlaceData(data);
        } catch (e) {
          setPlaceError(e instanceof Error ? e.message : "Failed to load buildings/roads for this area");
          setShowPlace(false);
        } finally {
          setIsPlaceLoading(false);
        }
      }
    },
    [placeData, site]
  );

  if (!site || !terrain) {
    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex justify-center gap-2 py-3 border-b border-border bg-panel">
          <ModeTab active={mode === "upload"} onClick={() => setMode("upload")}>
            Upload DXF Survey
          </ModeTab>
          <ModeTab active={mode === "location"} onClick={() => setMode("location")}>
            Pick a Real Location
          </ModeTab>
        </div>
        <div className="flex-1 min-h-0">
          {mode === "upload" ? (
            <UploadPanel onFile={handleFile} isLoading={isLoading} error={error} />
          ) : (
            <LocationPicker onFetch={handleLocationFetch} isLoading={isLoading} error={error} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 flex min-h-0">
        <Sidebar site={site} onReset={handleReset} groundwaterData={groundwaterData} />
        <main className="flex-1 relative">
          <TerrainViewer
            ref={viewerRef}
            terrain={terrain}
            projectId={site.project_id}
            onHover={setHover}
            exaggeration={exaggeration}
            colorMode={colorMode}
            measureMode={measureMode}
            placeData={placeData}
            showPlace={showPlace}
            boundaryCorners={site.boundary.corners}
            groundwaterData={groundwaterData}
          />
          <ViewToolbar
            colorMode={colorMode}
            onColorModeChange={setColorMode}
            onView={handleView}
            measureMode={measureMode}
            onMeasureModeChange={handleMeasureModeChange}
            isLocationBased={isLocationBased}
            showPlace={showPlace}
            onShowPlaceChange={handleShowPlaceChange}
            isPlaceLoading={isPlaceLoading}
          />
          <ExaggerationControl value={exaggeration} onChange={setExaggeration} />
          {placeError && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-w-sm bg-panel border border-warn/40 rounded-lg px-4 py-3 text-xs text-warn leading-relaxed">
              {placeError}
              <button
                className="block mt-2 text-muted hover:text-ink underline underline-offset-2"
                onClick={() => {
                  setPlaceError(null);
                }}
              >
                Dismiss
              </button>
            </div>
          )}
        </main>
      </div>
      <StatusBar hover={hover} projectId={site.project_id} />
    </div>
  );
}

function ExaggerationControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="absolute top-4 right-4 bg-panel/90 border border-border rounded-lg px-3 py-2.5 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted">Vertical exaggeration</span>
        <span className="readout text-xs text-amber ml-3">{value.toFixed(1)}x</span>
      </div>
      <input
        type="range"
        min={1}
        max={15}
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-44 accent-amber"
      />
      <p className="text-[10px] text-muted mt-1 max-w-[11rem] leading-snug">
        Real elevation, scaled for visibility. Hover, measurements, and building
        heights always use true (1x) values.
      </p>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-4 py-2 rounded transition-colors ${
        active ? "bg-teal/15 border border-teal/40 text-teal" : "text-muted hover:text-ink border border-transparent"
      }`}
    >
      {children}
    </button>
  );
}
