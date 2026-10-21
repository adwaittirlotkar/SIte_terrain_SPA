import { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BBox } from "../types";

interface Props {
  onFetch: (bbox: BBox) => void;
  isLoading: boolean;
  error: string | null;
}

const ESRI_SATELLITE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export default function LocationPicker({ onFetch, isLoading, error }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const rectRef = useRef<L.Rectangle | null>(null);
  const drawStartRef = useRef<L.LatLng | null>(null);

  const [bbox, setBbox] = useState<BBox | null>(null);
  const [goToInput, setGoToInput] = useState("19.0760, 72.8777"); // defaults to Mumbai, India
  const [demSource, setDemSource] = useState<"surface" | "bare_earth">("surface");

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: [19.0760, 72.8777], // Mumbai, India
      zoom: 15,
      zoomControl: true,
    });
    mapRef.current = map;

    L.tileLayer(ESRI_SATELLITE_URL, {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
    }).addTo(map);

    // --- click-drag rectangle selection ---------------------------------
    function onMouseDown(e: L.LeafletMouseEvent) {
      // Only start a draw on a plain drag when not already panning-click;
      // require the user to hold the map still first via a small guard:
      // we just always treat drag-from-empty-map as "start drawing".
      drawStartRef.current = e.latlng;
      map.dragging.disable();

      if (rectRef.current) {
        map.removeLayer(rectRef.current);
        rectRef.current = null;
      }
      const rect = L.rectangle([e.latlng, e.latlng], {
        color: "#E8A33D",
        weight: 2,
        fillColor: "#E8A33D",
        fillOpacity: 0.15,
      }).addTo(map);
      rectRef.current = rect;

      map.on("mousemove", onMouseMove);
      map.once("mouseup", onMouseUp);
    }

    function onMouseMove(e: L.LeafletMouseEvent) {
      if (!drawStartRef.current || !rectRef.current) return;
      rectRef.current.setBounds(L.latLngBounds(drawStartRef.current, e.latlng));
    }

    function onMouseUp(e: L.LeafletMouseEvent) {
      map.dragging.enable();
      map.off("mousemove", onMouseMove);
      if (!drawStartRef.current) return;
      const bounds = L.latLngBounds(drawStartRef.current, e.latlng);
      drawStartRef.current = null;

      // Ignore accidental clicks (no real drag distance)
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      if (Math.abs(ne.lat - sw.lat) < 0.0001 || Math.abs(ne.lng - sw.lng) < 0.0001) {
        if (rectRef.current) {
          map.removeLayer(rectRef.current);
          rectRef.current = null;
        }
        return;
      }

      setBbox({ south: sw.lat, north: ne.lat, west: sw.lng, east: ne.lng });
    }

    map.on("mousedown", onMouseDown);

    return () => {
      map.off("mousedown", onMouseDown);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const handleGoTo = useCallback(() => {
    const parts = goToInput.split(",").map((s: string) => parseFloat(s.trim()));
    if (parts.length !== 2 || parts.some(Number.isNaN)) return;
    mapRef.current?.setView([parts[0], parts[1]], 15);
  }, [goToInput]);

  const handleClear = useCallback(() => {
    if (rectRef.current && mapRef.current) {
      mapRef.current.removeLayer(rectRef.current);
      rectRef.current = null;
    }
    setBbox(null);
  }, []);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="px-5 py-3 border-b border-border bg-panel flex items-center gap-3 flex-wrap">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted whitespace-nowrap">
          Jump to
        </p>
        <input
          value={goToInput}
          onChange={(e) => setGoToInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGoTo()}
          placeholder="lat, lon"
          className="readout text-sm bg-panelAlt border border-border rounded px-2.5 py-1.5 text-ink w-44 focus:outline-none focus:border-teal/60"
        />
        <button
          onClick={handleGoTo}
          className="text-xs text-muted hover:text-teal transition-colors border border-border rounded px-2.5 py-1.5"
        >
          Go
        </button>
        <div className="flex-1" />
        <p className="text-xs text-muted">Click and drag on the map to select an area</p>
      </div>

      <div className="flex-1 relative min-h-0">
        <div ref={mapContainerRef} className="w-full h-full" />
      </div>

      <div className="px-5 py-3 border-t border-border bg-panel flex items-center gap-3 flex-wrap">
        {bbox ? (
          <div className="readout text-xs text-ink/80">
            {(bbox.north - bbox.south).toFixed(4)}&deg; &times; {(bbox.east - bbox.west).toFixed(4)}&deg; selected
          </div>
        ) : (
          <div className="text-xs text-muted">No area selected yet</div>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 mr-2">
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted mr-1">Elevation</span>
          <button
            onClick={() => setDemSource("surface")}
            title="Copernicus DEM direct - measures top of canopy/rooftops"
            className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
              demSource === "surface"
                ? "bg-teal/15 border-teal/40 text-teal"
                : "border-border text-muted hover:text-ink"
            }`}
          >
            Surface
          </button>
          <button
            onClick={() => setDemSource("bare_earth")}
            title="FABDEM - same data, forest/building height removed for true ground level"
            className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
              demSource === "bare_earth"
                ? "bg-teal/15 border-teal/40 text-teal"
                : "border-border text-muted hover:text-ink"
            }`}
          >
            Bare-earth
          </button>
        </div>
        {bbox && (
          <button
            onClick={handleClear}
            className="text-xs text-muted hover:text-warn transition-colors px-3 py-2"
          >
            Clear
          </button>
        )}
        <button
          disabled={!bbox || isLoading}
          onClick={() => bbox && onFetch({ ...bbox, dem_source: demSource })}
          className="text-sm px-4 py-2 rounded bg-teal/15 border border-teal/40 text-teal hover:bg-teal/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isLoading ? "Fetching terrain\u2026" : "Generate 3D Terrain"}
        </button>
      </div>

      {error && (
        <div className="mx-5 mb-4 text-xs leading-relaxed text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2.5">
          {error}
        </div>
      )}
    </div>
  );
}
