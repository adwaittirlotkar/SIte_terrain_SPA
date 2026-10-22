import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef, useState } from "react";

/**
 * MapPicker — satellite map for choosing a site by CLICKING boundary points.
 *
 * Workflow (vertex-by-corner polygon):
 *   1. Zoom to your plot and left-click once per corner of the boundary.
 *      Each click drops a numbered marker; consecutive corners are joined
 *      with a live outline and area readout in m².
 *   2. Mis-clicked? Click the small "×" on any vertex marker to delete it.
 *   3. When every corner is placed, press "Build terrain here". The polygon
 *      is sent to the backend, which samples real Copernicus GLO-30
 *      elevations INSIDE the drawn outline only.
 *
 * Leaflet is used imperatively so the map survives React re-renders inside
 * the modal. No rectangle/circle tools — pure point-connected polygons.
 */
export type Ring = [number, number][]; // [lat, lon]

export default function MapPicker({ onPick, busy }:
  { onPick: (lat: number, lon: number, halfM: number, polygon: Ring) => void;
    busy: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const ringRef = useRef<Ring>([]);
  const polyRef = useRef<L.Polygon | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const [ring, setRing] = useState<Ring>([]);
  const [areaM2, setAreaM2] = useState(0);

  function renderVertex(i: number) {
    const map = mapRef.current;
    if (!map) return;
    const [lat, lon] = ringRef.current[i];
    const icon = L.divIcon({
      className: "vertex-icon",
      html: `<div class="vertex-dot">${i + 1}<button class="vertex-del" title="Remove this point">×</button></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const m = L.marker([lat, lon], { icon, draggable: true, zIndexOffset: 1000 }).addTo(map);
    m.on("drag", () => {
      const p = m.getLatLng();
      ringRef.current[i] = [p.lat, p.lng];
      updateShape();
    });
    m.on("dragend", () => {
      const p = m.getLatLng();
      ringRef.current[i] = [p.lat, p.lng];
      setRing([...ringRef.current]);
      updateShape();
    });
    // Delete via the × button inside the divIcon.
    const el = m.getElement();
    el?.querySelector(".vertex-del")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeVertex(i);
    });
    markersRef.current[i] = m;
  }

  function removeVertex(i: number) {
    ringRef.current.splice(i, 1);
    markersRef.current.forEach((m) => m?.remove());
    markersRef.current = [];
    ringRef.current.forEach((_, j) => renderVertex(j));
    setRing([...ringRef.current]);
    updateShape();
  }

  function updateShape() {
    const map = mapRef.current;
    if (!map) return;
    const pts = ringRef.current;
    if (!lineRef.current) {
      lineRef.current = L.polyline(pts, { color: "#ffd166", weight: 2.5, dashArray: "4 4" }).addTo(map);
    } else lineRef.current.setLatLngs(pts);
    if (pts.length >= 3) {
      if (!polyRef.current) {
        polyRef.current = L.polygon(pts, {
          color: "#8ab4ff", weight: 2, fillColor: "#8ab4ff", fillOpacity: 0.15, interactive: false,
        }).addTo(map);
      } else polyRef.current.setLatLngs(pts);
    } else {
      polyRef.current?.remove();
      polyRef.current = null;
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

    // Left-click adds a boundary vertex. Double-click / right-click stay
    // available for map navigation (we disable leaflet's dblclick zoom so
    // rapid corner clicks don't fight each other).
    map.doubleClickZoom.disable();
    map.on("click", (e: L.LeafletMouseEvent) => {
      ringRef.current = [...ringRef.current, [e.latlng.lat, e.latlng.lng]];
      renderVertex(ringRef.current.length - 1);
      setRing([...ringRef.current]);
      updateShape();
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function redraw() {
    ringRef.current = [];
    setRing([]);
    setAreaM2(0);
    markersRef.current.forEach((m) => m?.remove());
    markersRef.current = [];
    polyRef.current?.remove(); polyRef.current = null;
    lineRef.current?.remove(); lineRef.current = null;
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
          <h3>Mark your plot boundary with points</h3>
          <button className="btn ghost small" onClick={redraw}>↺ Redraw</button>
        </div>
        <p className="hint">
          Zoom in to your land, then <b>left-click once at each corner</b> of the
          plot boundary. Points connect automatically into an outline. You can
          <b> drag a point</b> to adjust it or click its <b>×</b> to delete it.
          Elevation comes from the public Copernicus GLO‑30 model (~30 m grid) —
          great for visual studies, not survey-grade.
        </p>
        <div ref={hostRef} className="map-host" />
        <div className="map-controls">
          <div className="draw-readout">
            <span><b>{ring.length}</b> points</span>
            <span><b>{areaM2.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> m²</span>
            {!valid && ring.length > 0 && <em>Add at least 3 corners enclosing ≥ 200 m²</em>}
            {ring.length === 0 && <em>Click the first corner of the plot…</em>}
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
            {busy ? "Fetching elevation…" : valid ? "Build terrain here" : "Place boundary points"}
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
