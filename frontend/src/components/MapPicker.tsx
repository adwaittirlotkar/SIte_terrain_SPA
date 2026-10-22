import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef, useState } from "react";

/**
 * MapPicker — satellite map for choosing a site by DRAWING its boundary.
 *
 * Workflow (freehand polygon, like tracing a plot on paper):
 *   1. Press & hold the left mouse button anywhere on the map.
 *   2. Drag to trace the plot outline — vertices are captured automatically.
 *   3. Release the button to close the polygon. Live area readout in m².
 *   4. "Redraw" clears it; "Build terrain here" sends the polygon to the
 *      backend, which samples real Copernicus GLO-30 elevations INSIDE the
 *      drawn outline only.
 *
 * Leaflet is used imperatively so the map survives React re-renders inside
 * the modal. No rectangle/circle tools — pure freehand tracing.
 */
export type Ring = [number, number][]; // [lat, lon]

export default function MapPicker({ onPick, busy }:
  { onPick: (lat: number, lon: number, halfM: number, polygon: Ring) => void;
    busy: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawingRef = useRef(false);
  const ringRef = useRef<Ring>([]);
  const polyRef = useRef<L.Polygon | null>(null);
  const pathRef = useRef<L.Polyline | null>(null);
  const [ring, setRing] = useState<Ring>([]);
  const [areaM2, setAreaM2] = useState(0);

  function metersPerPixel(map: L.Map): number {
    const b = map.getBounds();
    const px = map.getPixelBounds();
    const widthPx = Math.max(1, (px?.max?.x ?? 0) - (px?.min?.x ?? 0));
    const degPerPx = (b.getEast() - b.getWest()) / widthPx;
    return degPerPx * 111_320 * Math.cos((map.getCenter().lat * Math.PI) / 180);
  }

  function updateShape() {
    const map = mapRef.current;
    if (!map) return;
    const pts = ringRef.current;
    if (!pathRef.current) {
      pathRef.current = L.polyline(pts, { color: "#ffd166", weight: 2.5, dashArray: "4 4" }).addTo(map);
    } else pathRef.current.setLatLngs(pts);
    if (pts.length >= 3) {
      if (!polyRef.current) {
        polyRef.current = L.polygon(pts, {
          color: "#8ab4ff", weight: 2, fillColor: "#8ab4ff", fillOpacity: 0.15,
        }).addTo(map);
      } else polyRef.current.setLatLngs(pts);
    }
    setAreaM2(polyAreaM2(pts));
  }

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, { zoomControl: true, attributionControl: true })
      .setView([19.076, 72.877], 5); // India default
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" }
    ).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);

    const capture = (e: L.LeafletMouseEvent) => {
      const last = ringRef.current[ringRef.current.length - 1];
      if (last && map.distance(last, e.latlng) < 8 * metersPerPixel(map)) return;
      ringRef.current = [...ringRef.current, [e.latlng.lat, e.latlng.lng]];
      setRing(ringRef.current);
      updateShape();
    };

    map.on("mousedown", (e: L.LeafletMouseEvent) => {
      if (e.originalEvent.button !== 0) return;
      drawingRef.current = true;
      ringRef.current = [[e.latlng.lat, e.latlng.lng]];
      setRing(ringRef.current);
      updateShape();
      map.dragging.disable(); // we own the mouse while drawing
    });
    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (drawingRef.current) capture(e);
    });
    const stop = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      map.dragging.enable();
      if (ringRef.current.length >= 3) {
        map.fitBounds(L.polygon(ringRef.current).getBounds().pad(0.2));
      }
      updateShape();
    };
    map.on("mouseup", stop);
    map.on("mouseout", stop);

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function redraw() {
    ringRef.current = [];
    setRing([]);
    setAreaM2(0);
    polyRef.current?.remove(); polyRef.current = null;
    pathRef.current?.remove(); pathRef.current = null;
  }

  const centroid = (): [number, number] => {
    let la = 0, lo = 0;
    for (const [a, b] of ring) { la += a; lo += b; }
    return [la / ring.length, lo / ring.length];
  };

  const valid = ring.length >= 3 && areaM2 > 200; // ≥200 m² sensible plot size

  return (
    <div className="modal-backdrop">
      <div className="modal map-modal">
        <div className="modal-head">
          <h3>Trace your plot on the satellite map</h3>
          <button className="btn ghost small" onClick={redraw}>↺ Redraw</button>
        </div>
        <p className="hint">
          <b>Press and hold</b> the left mouse button, <b>drag to trace</b> the plot
          boundary, then <b>release</b> to finish. Zoom in first for accurate tracing.
          Elevation comes from the public Copernicus GLO‑30 model (~30 m grid) — great
          for visual studies, not survey-grade.
        </p>
        <div ref={hostRef} className="map-host" />
        <div className="map-controls">
          <div className="draw-readout">
            <span><b>{ring.length}</b> points</span>
            <span><b>{areaM2.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> m²</span>
            {!valid && ring.length > 0 && <em>Draw a larger closed shape (≥ 3 corners, ≥ 200 m²)</em>}
            {ring.length === 0 && <em>Awaiting your first click-and-drag…</em>}
          </div>
          <button
            className="btn primary"
            disabled={!valid || busy}
            onClick={() => {
              if (!valid) return;
              const [lat, lon] = centroid();
              const half = Math.min(1000, Math.max(30, Math.sqrt(areaM2 / Math.PI)));
              onPick(lat, lon, half, ring);
            }}>
            {busy ? "Fetching elevation…" : valid ? "Build terrain here" : "Trace the boundary first"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shoelace area in m² using local ENU projection about the first vertex. */
function polyAreaM2(ring: Ring): number {
  if (ring.length < 3) return 0;
  const [lat0, lon0] = ring[0];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111_320;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [a1, b1] = ring[i];
    const [a2, b2] = ring[(i + 1) % ring.length];
    const x1 = (b1 - lon0) * kx, y1 = (a1 - lat0) * ky;
    const x2 = (b2 - lon0) * kx, y2 = (a2 - lat0) * ky;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
