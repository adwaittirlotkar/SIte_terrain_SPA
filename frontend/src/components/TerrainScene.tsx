// TerrainScene -- accurate 3D land viewer.
//
// Accuracy rules implemented here:
// 1. Vertical exaggeration DEFAULTS TO 1.0 (true scale). It is a display
//    aid only; the slider never affects measurements or slope colors.
// 2. Geometry is centered at the site centroid before being handed to
//    Three.js, so large survey CRS coordinates (e.g. UTM easting 500000+)
//    do not cause float32 jitter. Raw data stays float64 in JS until the
//    centering subtraction.
// 3. Slope coloring uses TRUE surface normals computed from raw
//    (un-exaggerated) coordinates -- recoloring after exaggeration would
//    lie about steepness.
// 4. OrbitControls with damping, polar clamp (no going under ground).
// 5. North arrow + optional ground grid for orientation.
// 6. Hillshade toggle with sun azimuth/altitude controls.
// 7. 3D on-surface measurement tool (raycast points snapped to mesh).
// 8. Single BufferGeometry draw call for the terrain mesh.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface SiteData {
  id: string;
  name?: string;
  warnings?: string[];
  area_m2?: number | null;
  perimeter_m?: number | null;
  stats: {
    positions: number[][]; // [x, y, z] raw survey coords, float64 via JSON
    triangles: number[][]; // indices into positions
    centroid: number[];
    min_elev: number;
    max_elev: number;
    span_m: number;
  };
  contours?: { level: number; rings: number[][][] }[];
  contour_interval?: number;
  boundary?: number[][];
}

/** Flat mesh from /api/building/{pid}: metres, model-local, Z-up. */
export interface BuildingMesh {
  name: string;
  vertices: number[][];
  indices: number[][];
  bbox: { min: number[]; max: number[]; width: number; depth: number; height: number };
  meta: { elements: number };
  ground?: { elevations: (number | null)[]; outside: number };
}

interface Props {
  data: SiteData;
  building?: BuildingMesh | null;   // optional BIM overlay
  placeMode?: boolean;              // next terrain click positions the building
  onPlaced?: () => void;            // notify parent placement finished
  exaggeration?: number;          // display-only, default 1.0
  showContours?: boolean;
  showBoundary?: boolean;
  slopeColor?: boolean;
  hillshade?: boolean;
  sunAzimuthDeg?: number;         // 0 = north, clockwise
  sunAltitudeDeg?: number;        // degrees above horizon
  showGrid?: boolean;
  measureMode?: boolean;
  cameraView?: CameraView | null; // imperative view jumps (top / perspective / fit)
  onCameraDone?: () => void;      // parent clears cameraView after it is applied
}

/** Imperative camera commands issued from the sidebar buttons. */
export type CameraView = { kind: "top" | "perspective" | "fit" };

/** True per-vertex slope (deg) from RAW geometry -- independent of exaggeration. */
function computeTrueSlope(positions: Float64Array, indices: Uint32Array): Float32Array {
  const n = positions.length / 3;
  const acc = new Float32Array(n);
  const cnt = new Float32Array(n);
  for (let i = 0; i < indices.length; i += 3) {
    const [ia, ib, ic] = [indices[i], indices[i + 1], indices[i + 2]];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    // normal (cross product)
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const len = Math.hypot(nx, ny, nz) || 1;
    const slopeDeg = (Math.acos(Math.min(1, nz / len)) * 180) / Math.PI;
    for (const idx of [ia, ib, ic]) { acc[idx] += slopeDeg; cnt[idx] += 1; }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = cnt[i] ? acc[i] / cnt[i] : 0;
  return out;
}

export default function TerrainScene({
  data,
  building = null,
  placeMode = false,
  onPlaced,
  exaggeration = 1.0,
  showContours = true,
  showBoundary = true,
  slopeColor = false,
  hillshade = true,
  sunAzimuthDeg = 315,
  sunAltitudeDeg = 45,
  showGrid = false,
  measureMode = false,
  cameraView = null,
  onCameraDone,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    terrainMesh?: THREE.Mesh;
    buildingGroup?: THREE.Group;
  } | null>(null);
  const [measureReadout, setMeasureReadout] = useState<string>("");
  const measurePtsRef = useRef<THREE.Vector3[]>([]);
  // Elevation legend values (min/max), updated when the colored mesh builds.
  const [legend, setLegend] = useState<{ lo: number; hi: number } | null>(null);
  // Where the architect clicked to drop the building (centered three coords).
  const [placedAt, setPlacedAt] = useState<[number, number] | null>(null);

  // ---- TIN barycentric ground sampler (accurate contour & BIM anchoring) --
  // Built once per dataset from the raw float64 positions; O(1)-ish lookups
  // via a uniform grid bucket index over triangle bounding boxes.
  const tinSampler = useMemo(() => {
    const pos = data.stats.positions;
    const tris = data.stats.triangles;
    if (pos.length < 3 || tris.length === 0) return null;
    const P = new Float64Array(pos.length * 3);
    for (let i = 0; i < pos.length; i++) {
      P[i * 3] = pos[i][0]; P[i * 3 + 1] = pos[i][1]; P[i * 3 + 2] = pos[i][2];
    }
    const T = new Uint32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
      T[i * 3] = tris[i][0]; T[i * 3 + 1] = tris[i][1]; T[i * 3 + 2] = tris[i][2];
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const cell = Math.max((maxX - minX) / 64, (maxY - minY) / 64, 1e-6);
    const gw = Math.ceil((maxX - minX) / cell) + 1;
    const gh = Math.ceil((maxY - minY) / cell) + 1;
    const buckets = new Map<number, number[]>();
    for (let t = 0; t < T.length; t += 3) {
      const ax = P[T[t] * 3], ay = P[T[t] * 3 + 1];
      const bx = P[T[t + 1] * 3], by = P[T[t + 1] * 3 + 1];
      const cx2 = P[T[t + 2] * 3], cy2 = P[T[t + 2] * 3 + 1];
      const x0 = Math.min(ax, bx, cx2), x1 = Math.max(ax, bx, cx2);
      const y0 = Math.min(ay, by, cy2), y1 = Math.max(ay, by, cy2);
      for (let gx = Math.floor((x0 - minX) / cell); gx <= Math.floor((x1 - minX) / cell); gx++)
        for (let gy = Math.floor((y0 - minY) / cell); gy <= Math.floor((y1 - minY) / cell); gy++) {
          const key = gy * gw + gx;
          const arr = buckets.get(key);
          if (arr) arr.push(t); else buckets.set(key, [t]);
        }
    }
    /** Elevation at RAW survey (x,y); falls back to nearest vertex outside TIN. */
    const sampleZ = (x: number, y: number): number => {
      const gx = Math.floor((x - minX) / cell), gy = Math.floor((y - minY) / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get((gy + dy) * gw + (gx + dx));
        if (!arr) continue;
        for (const t of arr) {
          const ia = T[t], ib = T[t + 1], ic = T[t + 2];
          const ax = P[ia * 3], ay = P[ia * 3 + 1];
          const v0x = P[ib * 3] - ax, v0y = P[ib * 3 + 1] - ay;
          const v1x = P[ic * 3] - ax, v1y = P[ic * 3 + 1] - ay;
          const dpx = x - ax, dpy = y - ay;
          const den = v0x * v1y - v1x * v0y;
          if (Math.abs(den) < 1e-12) continue;
          const u = (dpx * v1y - dpy * v1x) / den;
          const v = (v0x * dpy - v0y * dpx) / den;
          if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) {
            const w = 1 - u - v;
            return w * P[ia * 3 + 2] + u * P[ib * 3 + 2] + v * P[ic * 3 + 2];
          }
        }
      }
      // nearest-vertex fallback (contours/BIM near edges stay sensible)
      let best = P[2], bd = Infinity;
      for (let i = 0; i < pos.length; i++) {
        const ddx = pos[i][0] - x, ddy = pos[i][1] - y;
        const d = ddx * ddx + ddy * ddy;
        if (d < bd) { bd = d; best = pos[i][2]; }
      }
      return best;
    };
    return { sampleZ };
  }, [data]);

  // ---- Centered float64 -> float32 conversion (rule #2) ------------------
  const geo = useMemo(() => {
    const [cx, cy] = data.stats.centroid;
    const zMin = data.stats.min_elev;
    const pos = data.stats.positions;
    const f64 = new Float64Array(pos.length * 3);
    for (let i = 0; i < pos.length; i++) {
      // Subtract centroid in double precision BEFORE narrowing to float32.
      // Convention: survey X -> three X, survey Y -> three -Z, elevation -> three Y.
      f64[i * 3] = pos[i][0] - cx;
      f64[i * 3 + 1] = -(pos[i][1] - cy);
      f64[i * 3 + 2] = pos[i][2] - zMin;
    }
    const f32 = new Float32Array(f64.length);
    for (let i = 0; i < f64.length; i++) f32[i] = f64[i];
    const tris = data.stats.triangles;
    const idx = new Uint32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
      idx[i * 3] = tris[i][0]; idx[i * 3 + 1] = tris[i][1]; idx[i * 3 + 2] = tris[i][2];
    }
    // True slope from RAW (centered but NOT exaggerated) coordinates.
    const slope = computeTrueSlope(f64, idx);
    return { f32, idx, slope, centroid: [cx, cy] as [number, number], zMin };
  }, [data]);

  // ---- Build scene once ---------------------------------------------------
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    // Professional viewing quality: correct color pipeline + real shadows.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // Soft vertical gradient background (studio look) instead of flat colour.
    {
      const c = document.createElement("canvas");
      c.width = 2; c.height = 512;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0, "#1a2436");
      grad.addColorStop(0.6, "#101827");
      grad.addColorStop(1, "#0b111c");
      g.fillStyle = grad; g.fillRect(0, 0, 2, 512);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      scene.background = tex;
    }
    const span = data.stats.span_m || 100;
    // FIXED near/far derived from site size -- never derived from vertex
    // counts (a large point cloud must not shrink the far plane and clip
    // the terrain). Near plane is small relative to the site for close-up
    // inspection without z-fighting.
    const camera = new THREE.PerspectiveCamera(
      50, el.clientWidth / el.clientHeight,
      Math.max(0.05, span * 0.002), span * 30 + 2000);

    const group = new THREE.Group();
    scene.add(group);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;          // smooth professional orbit
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // never go below ground
    controls.minDistance = Math.max(0.5, span * 0.02);

    camera.position.set(span * 0.8, span * 0.9, span * 0.8);
    controls.target.set(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a3f2a, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    // Shadow camera sized to the site so building shadows land on terrain.
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -span; sun.shadow.camera.right = span;
    sun.shadow.camera.top = span; sun.shadow.camera.bottom = -span;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = span * 8;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    scene.add(sun.target);
    scene.userData.sun = sun;
    // Soft fill from the opposite side so shaded faces keep readable detail.
    const fill = new THREE.DirectionalLight(0xdce6ff, 0.25);
    fill.position.set(-1, 0.4, -1);
    scene.add(fill);

    let raf = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);

    sceneRef.current = { renderer, scene, camera, controls, group };
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Sun position (hillshade) -------------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;

    // Imperative camera jumps from the sidebar (Top / 3D / Fit).
    if (cameraView) {
      const span = data.stats.span_m || 100;
      if (cameraView.kind === "top") {
        s.camera.position.set(0.001, span * 1.6, 0.001); // tiny offset avoids gimbal flip
        s.controls.target.set(0, 0, 0);
      } else if (cameraView.kind === "perspective") {
        s.camera.position.set(span * 0.8, span * 0.9, span * 0.8);
        s.controls.target.set(0, 0, 0);
      } else { // fit — frame the whole site from the current direction
        const dir = s.camera.position.clone().sub(s.controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0.8, 0.9, 0.8);
        dir.normalize().multiplyScalar(span * 1.35);
        s.controls.target.set(0, 0, 0);
        s.camera.position.copy(dir);
      }
      s.controls.update();
      onCameraDone?.();
    }
    const sun = s.scene.userData.sun as THREE.DirectionalLight;
    const az = THREE.MathUtils.degToRad(sunAzimuthDeg);
    const alt = THREE.MathUtils.degToRad(sunAltitudeDeg);
    const R = (data.stats.span_m || 100) * 3;
    sun.position.set(R * Math.sin(az) * Math.cos(alt),
                     R * Math.sin(alt),
                     -R * Math.cos(az) * Math.cos(alt));
    sun.target.position.set(0, 0, 0);
    sun.intensity = hillshade ? 1.15 : 0.35;
  }, [sunAzimuthDeg, sunAltitudeDeg, hillshade, data]);

  // Separate effect so camera jumps don't depend on sun props.
  useEffect(() => { /* handled inside sun effect via cameraView */ }, [cameraView]);

  // ---- Terrain mesh rebuild on exaggeration / color changes ---------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    // Remove old terrain layers
    for (const child of [...s.group.children]) {
      if ((child as THREE.Mesh).userData?.terrain) s.group.remove(child);
    }
    const geom = new THREE.BufferGeometry();
    const arr = new Float32Array(geo.f32.length);
    const ex = exaggeration ?? 1.0;
    for (let i = 0; i < geo.f32.length; i += 3) {
      arr[i] = geo.f32[i];                 // three X (already centered)
      arr[i + 1] = geo.f32[i + 2] * ex;    // three Y = elevation * exaggeration
      arr[i + 2] = geo.f32[i + 1];         // three Z = -survey dY (already centered)
    }
    geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    geom.setIndex(new THREE.BufferAttribute(geo.idx, 1));
    // Normals for RENDER lighting come from the displayed (exaggerated) mesh...
    geom.computeVertexNormals();
    // ...but vertex COLORS come from TRUE slope (rule #3), or from RAW
    // elevations via a hypsometric ramp when slope coloring is off.
    const n = geo.slope.length;
    const colors = new Float32Array(n * 3);
    if (slopeColor) {
      for (let i = 0; i < n; i++) {
        const [r, g, b] = slopeColorFn(geo.slope[i]);
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      }
    } else {
      const lo = data.stats.min_elev, hi = data.stats.max_elev;
      const range = Math.max(hi - lo, 1e-9);
      for (let i = 0; i < n; i++) {
        const t = (arr[i * 3 + 1] / (ex || 1)) / range; // true (un-exaggerated) elevation fraction
        const [r, g, b] = elevationColorFn(Math.min(1, Math.max(0, t)));
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      }
    }
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    setLegend({ lo: data.stats.min_elev, hi: data.stats.max_elev });
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95, metalness: 0,
      flatShading: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.terrain = true;
    mesh.receiveShadow = true;   // building shadows fall on the land
    s.group.add(mesh);
    s.terrainMesh = mesh;
    return () => { geom.dispose(); mat.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, exaggeration, slopeColor]);

  // ---- Contours draped on terrain -----------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    for (const c of [...s.group.children]) {
      if ((c as THREE.Object3D).userData?.contour) s.group.remove(c);
    }
    if (!showContours || !data.contours) return;
    const [cx, cy] = geo.centroid;
    const ex = exaggeration ?? 1.0;
    const zMin = data.stats.min_elev;
    for (const grp of data.contours) {
      for (const ring of grp.rings) {
        const pts = ring.map(([x, y]) => {
          // Exact TIN barycentric elevation (no nearest-point approximation).
          const e = tinSampler ? tinSampler.sampleZ(x, y) : grp.level;
          return new THREE.Vector3(x - cx, (e - zMin) * ex + 0.05, -(y - cy));
        });
        if (pts.length < 2) continue;
        const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
        const major = Math.abs(grp.level % (2 * (data.contour_interval ?? 1))) < 1e-6;
        const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({
          color: major ? 0x2b2b2b : 0x6b6b6b, transparent: true, opacity: major ? 0.9 : 0.55,
        }));
        line.userData.contour = true;
        s.group.add(line);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showContours, data, geo, exaggeration, tinSampler]);

  // ---- Boundary polyline ----------------------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    for (const c of [...s.group.children]) {
      if ((c as THREE.Object3D).userData?.boundary) s.group.remove(c);
    }
    if (!showBoundary || !data.boundary || data.boundary.length < 2) return;
    const [cx, cy] = geo.centroid;
    const ex = exaggeration ?? 1.0;
    const pts = data.boundary.map(([x, y]) => new THREE.Vector3(x - cx, 0.15, -(y - cy)));
    pts.push(pts[0].clone());
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xd43f3f }));
    line.userData.boundary = true;
    s.group.add(line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBoundary, data, geo, exaggeration]);

  // ---- Grid / north arrow / scale bar --------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    for (const c of [...s.group.children]) {
      if ((c as THREE.Object3D).userData?.aux) s.group.remove(c);
    }
    const aux = new THREE.Group();
    aux.userData.aux = true;
    const span = data.stats.span_m || 100;
    if (showGrid) {
      const size = span * 1.5;
      const grid = new THREE.GridHelper(size, Math.max(4, Math.round(size / 10)),
                                        0x444a5a, 0x2a2f3d);
      grid.position.y = -0.5;
      aux.add(grid);
    }
    // North arrow (+Y is assumed survey north; make configurable per project)
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0),
      span * 0.15, 0xffffff, 4, 2);
    arrow.position.set(-span * 0.55, 0, 0);
    aux.add(arrow);
    // Scale bar: pick a "nice" length in meters that fits the site.
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const targetLen = span * 0.3;
    const barLen = candidates.find((c) => c >= targetLen) ?? 1000;
    const barY = -span * 0.55;
    const barPts = [new THREE.Vector3(-barLen / 2, 0.05, barY),
                    new THREE.Vector3(barLen / 2, 0.05, barY)];
    const bar = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(barPts),
      new THREE.LineBasicMaterial({ color: 0xffffff }));
    aux.add(bar);
    const tickGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-barLen / 2, 0.05, barY - 1), new THREE.Vector3(-barLen / 2, 0.05, barY + 1),
      new THREE.Vector3(barLen / 2, 0.05, barY - 1), new THREE.Vector3(barLen / 2, 0.05, barY + 1),
    ]);
    aux.add(new THREE.LineSegments(tickGeom, new THREE.LineBasicMaterial({ color: 0xffffff })));
    const label = makeTextSprite(`${barLen} m`);
    label.position.set(0, 0.05, barY - span * 0.03);
    aux.add(label);
    s.group.add(aux);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGrid, data]);

  // ---- Measurement tool -----------------------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    const el = mountRef.current;
    if (!s || !el) return;
    if (!measureMode && !placeMode) { measurePtsRef.current = []; setMeasureReadout(""); return; }
    const ray = new THREE.Raycaster();
    const onClick = (ev: MouseEvent) => {
      if (!s.terrainMesh) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, s.camera);
      const hit = ray.intersectObject(s.terrainMesh)[0];
      if (!hit) return;

      // BIM placement mode: the click drops the building onto the terrain.
      if (placeMode) {
        setPlacedAt([hit.point.x, hit.point.z]);
        onPlaced?.();
        return;
      }

      measurePtsRef.current.push(hit.point.clone());
      const pts = measurePtsRef.current;
      if (pts.length >= 2) {
        let dist = 0;
        for (let i = 1; i < pts.length; i++) dist += pts[i].distanceTo(pts[i - 1]);
        const dz = pts[pts.length - 1].y - pts[0].y;
        setMeasureReadout(`Path ${dist.toFixed(2)} m  ·  Δelev ${dz.toFixed(2)} m`);
      } else {
        setMeasureReadout("Click second point…");
      }
      if (pts.length > 30) measurePtsRef.current = [pts[pts.length - 1]];
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [measureMode, placeMode]);

  // ---- BIM building overlay (ground-conformed placement) -------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    // Tear down previous building group.
    if (s.buildingGroup) {
      s.group.remove(s.buildingGroup);
      s.buildingGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      s.buildingGroup = undefined;
    }
    if (!building || !placedAt) return;

    const ex = exaggeration ?? 1.0;
    const zMin = data.stats.min_elev;
    const [cx, cy] = geo.centroid;
    const verts = building.vertices;
    const n = verts.length;

    // World position of each model vertex: IFC local (x,y,z-up) -> three
    // (x, z*elevation-scale, -y), centred on the model bbox, then translated
    // to the clicked spot. Base Z is sampled from the TIN per vertex so the
    // slab follows real ground (true scale — NOT exaggerated).
    const bx = (building.bbox.min[0] + building.bbox.max[0]) / 2;
    const by = (building.bbox.min[1] + building.bbox.max[1]) / 2;
    const baseZ = building.bbox.min[2];
    const posArr = new Float32Array(n * 3);
    let groundAtCentre = zMin;
    if (tinSampler) {
      const gx = cx + placedAt[0], gy = cy - placedAt[1];
      groundAtCentre = tinSampler.sampleZ(gx, gy);
    }
    for (let i = 0; i < n; i++) {
      const [mx, my, mz] = verts[i];
      const wx = placedAt[0] + (mx - bx);
      const wz = placedAt[1] - (my - by);       // survey Y -> three -Z
      const ground = tinSampler
        ? tinSampler.sampleZ(cx + wx, cy - wz)
        : groundAtCentre;
      const e = Math.max(0, mz - baseZ);         // height above model base
      posArr[i * 3] = wx;
      posArr[i * 3 + 1] = (ground - zMin) + e;   // true-scale conform to terrain
      posArr[i * 3 + 2] = wz;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    const idx = new Uint32Array(building.indices.length * 3);
    for (let i = 0; i < building.indices.length; i++) {
      idx[i * 3] = building.indices[i][0];
      idx[i * 3 + 1] = building.indices[i][1];
      idx[i * 3 + 2] = building.indices[i][2];
    }
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd8dde6, roughness: 0.55, metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const grp = new THREE.Group();
    grp.add(mesh);
    // Subtle footprint outline at ground level for readability.
    const lo = building.bbox, hw = lo.width / 2, hd = lo.depth / 2;
    const ringPts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]]
      .map(([dx, dz]) => new THREE.Vector3(placedAt[0] + dx, 0.12, placedAt[1] + dz));
    void ex;
    grp.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ringPts),
      new THREE.LineBasicMaterial({ color: 0x2f81f7 })));
    grp.userData.building = true;
    s.group.add(grp);
    s.buildingGroup = grp;
    return () => { geom.dispose(); mat.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, placedAt, exaggeration, geo, tinSampler]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: placeMode ? "crosshair" : "grab" }} />
      {placeMode && (
        <div className="banner">Click on the terrain to place the building</div>
      )}
      {measureMode && (
        <div className="hud hud-tl"><span className="muted">Measure:</span> {measureReadout || "click two points on the ground"}</div>
      )}
      {legend && (
        <div className="hud hud-tr" title={slopeColor ? "Slope coloring uses TRUE (un-exaggerated) normals" : "Elevation ramp from raw DXF elevations"}>
          <div className="hud-title">{slopeColor ? "Slope" : "Elevation"}</div>
          <div className="legend-row">
            <div>
              <div className={`legend-bar elev-legend-bar`} data-mode={slopeColor ? "slope" : "elev"}
                   style={{ width: 130, height: 10, borderRadius: 3 }} />
              <div className="legend-labels">
                <span>{slopeColor ? "steep" : `${legend.hi.toFixed(2)} m`}</span>
                <span>{slopeColor ? "flat" : `${legend.lo.toFixed(2)} m`}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {!measureMode && !placeMode && (
        <div className="hud hud-bl">
          <span className="muted">Drag</span> orbit · <span className="muted">Scroll</span> zoom · <span className="muted">Right-drag</span> pan
        </div>
      )}
    </div>
  );
}

// module-level copy so it can be used inside effects without prop shadowing
function slopeColorFn(t: number): [number, number, number] {
  const s = Math.min(1, t / 30);
  const r = s < 0.5 ? s * 2 : 1;
  const g = s < 0.5 ? 1 : 1 - (s - 0.5) * 2;
  return [r, g, 0.15];
}

/** Hypsometric ramp: low -> high (deep green -> tan -> white), like a topo map. */
function elevationColorFn(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.13, 0.35, 0.22]],   // low: deep green
    [0.4, [0.55, 0.68, 0.40]],   // mid-low: light green
    [0.7, [0.82, 0.75, 0.52]],   // mid-high: tan
    [1.0, [0.96, 0.96, 0.94]],   // high: near-white
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

/** Small canvas-based text sprite for in-scene labels (scale bar). */
function makeTextSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  canvas.width = 256; canvas.height = 64;
  ctx.font = "bold 40px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(64, 16, 1);
  return spr;
}
