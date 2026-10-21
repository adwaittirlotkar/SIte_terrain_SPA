import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TerrainData, PlaceData, GroundwaterData } from "../types";

export type ColorMode = "elevation" | "slope";
export type ViewPreset = "iso" | "top" | "side";

interface Props {
  terrain: TerrainData;
  projectId: string;
  onHover: (info: { x: number; y: number; z: number } | null) => void;
  exaggeration: number;
  colorMode: ColorMode;
  measureMode: boolean;
  placeData: PlaceData | null;
  showPlace: boolean;
  boundaryCorners: number[][] | null;
  groundwaterData: GroundwaterData | null;
}

export interface TerrainViewerHandle {
  setView: (preset: ViewPreset) => void;
  clearMeasurement: () => void;
}

const ELEV_LOW = new THREE.Color("#1F7A70");    // deep teal - low ground
const ELEV_HIGH = new THREE.Color("#E8A33D");   // amber - high ground
const SLOPE_FLAT = new THREE.Color("#3FA88C");  // buildable - green-teal
const SLOPE_STEEP = new THREE.Color("#E8623D"); // steep - warn red
const SLOPE_MAX_DEG = 35; // slope coloring saturates at this angle
const MEASURE_COLOR = 0xffd166;
const BUILDING_COLOR_REAL = 0xc9b896;      // real OSM height - warm stone
const BUILDING_COLOR_ESTIMATED = 0x8a8fa3; // estimated height - cooler, deliberately less "trustworthy" looking

// Photorealistic terrain colors
const TERRAIN_GRASS = new THREE.Color("#4a5f3a");   // grass green
const TERRAIN_ROCK = new THREE.Color("#6b5d52");    // rock brown
const TERRAIN_SNOW = new THREE.Color("#e8f0f5");    // snow white-blue

// Real OSM `highway` tag values, not a guess - a thin white line for every
// road regardless of type was hard to read at a glance; a highway and a
// footpath should not look the same width.
const ROAD_MAJOR_TYPES = new Set(["motorway", "trunk", "primary"]);
const ROAD_MEDIUM_TYPES = new Set(["secondary", "tertiary", "residential", "unclassified", "living_street"]);
function roadStyle(roadType: string): { width: number; color: number; opacity: number } {
  if (ROAD_MAJOR_TYPES.has(roadType)) return { width: 6, color: 0xffffff, opacity: 0.95 };
  if (ROAD_MEDIUM_TYPES.has(roadType)) return { width: 4, color: 0xe6edf3, opacity: 0.85 };
  return { width: 2, color: 0x9aa5b1, opacity: 0.6 }; // service/track/footway/cycleway/etc.
}

// A real flat ribbon (not a THREE.Line, whose on-screen width three.js can't
// reliably control across GPUs) - a quad strip offset perpendicular to the
// road's direction at each point, width in real meters.
function buildRoadRibbon(points: THREE.Vector3[], width: number): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let dir: THREE.Vector3;
    if (i === 0) dir = points[1].clone().sub(points[0]);
    else if (i === points.length - 1) dir = points[i].clone().sub(points[i - 1]);
    else dir = points[i + 1].clone().sub(points[i - 1]);
    dir.y = 0;
    if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0);
    dir.normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
    positions.push(p.x - perp.x, p.y, p.z - perp.z);
    positions.push(p.x + perp.x, p.y, p.z + perp.z);
  }
  const indices: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  return geom;
}

const BOUNDARY_COLOR = 0x4fd1c5; // app's existing "selection/active" teal accent
const GROUNDWATER_COLOR = 0x3d7ce8; // distinct blue - reads as "water" unambiguously

// Nearest-neighbor terrain height lookup - cheap and fine for a handful of
// boundary corners against a terrain mesh with at most a few thousand points.
function sampleTerrainHeight(x: number, y: number, vertices: number[][]): number {
  let best = Infinity;
  let bestZ = 0;
  for (const v of vertices) {
    const dx = v[0] - x, dy = v[1] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      bestZ = v[2];
    }
  }
  return bestZ;
}

// Scale bar step values in meters
const SCALE_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

// Generate procedural sediment layer texture for geological cross-section
function createGeologicalLayerTexture(width: number, height: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Sediment layers with natural color variation
  const layers = [
    { startY: 0, endY: 0.15, color: "#8b7355", name: "topsoil" },
    { startY: 0.15, endY: 0.28, color: "#9d8569", name: "clay" },
    { startY: 0.28, endY: 0.42, color: "#a89176", name: "sandy-clay" },
    { startY: 0.42, endY: 0.58, color: "#7a6b5d", name: "weathered-rock" },
    { startY: 0.58, endY: 0.72, color: "#6b5d52", name: "fractured-rock" },
    { startY: 0.72, endY: 0.85, color: "#5a4d45", name: "bedrock-1" },
    { startY: 0.85, endY: 1.0, color: "#4a3f38", name: "bedrock-2" },
  ];

  layers.forEach((layer) => {
    const y1 = layer.startY * height;
    const y2 = layer.endY * height;
    const layerHeight = y2 - y1;

    // Base layer color
    ctx.fillStyle = layer.color;
    ctx.fillRect(0, y1, width, layerHeight);

    // Add horizontal striations for realism
    const striations = Math.floor(layerHeight / 8);
    for (let i = 0; i < striations; i++) {
      const striationY = y1 + (i / striations) * layerHeight;
      const alpha = 0.05 + Math.random() * 0.1;
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.fillRect(0, striationY, width, 1 + Math.random() * 2);
    }

    // Add subtle noise texture
    for (let x = 0; x < width; x += 2) {
      for (let y = y1; y < y2; y += 2) {
        if (Math.random() > 0.7) {
          const noise = Math.random() * 0.08;
          ctx.fillStyle = `rgba(255, 255, 255, ${noise})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

// Generate detailed grass texture with varied colors and organic patterns
function createGrassTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Base grass color with variation
  const baseColors = ["#3d5229", "#4a5f3a", "#556b3e", "#4d5f38"];

  for (let x = 0; x < size; x += 2) {
    for (let y = 0; y < size; y += 2) {
      const color = baseColors[Math.floor(Math.random() * baseColors.length)];
      const brightness = 0.85 + Math.random() * 0.3;
      ctx.fillStyle = adjustBrightness(color, brightness);
      ctx.fillRect(x, y, 2, 2);
    }
  }

  // Add darker grass blade patterns
  for (let i = 0; i < size * 8; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const length = 2 + Math.random() * 4;
    const angle = Math.random() * Math.PI * 2;

    ctx.strokeStyle = `rgba(30, 40, 20, ${0.3 + Math.random() * 0.3})`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Generate rocky texture with varied colors and cracks
function createRockTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Base rock colors
  const baseColors = ["#5a4d45", "#6b5d52", "#7a6b5d", "#6d5f56"];

  for (let x = 0; x < size; x += 3) {
    for (let y = 0; y < size; y += 3) {
      const color = baseColors[Math.floor(Math.random() * baseColors.length)];
      const brightness = 0.7 + Math.random() * 0.5;
      ctx.fillStyle = adjustBrightness(color, brightness);
      ctx.fillRect(x, y, 3 + Math.random() * 2, 3 + Math.random() * 2);
    }
  }

  // Add rock cracks and details
  for (let i = 0; i < size * 3; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const length = 5 + Math.random() * 15;
    const angle = Math.random() * Math.PI * 2;

    ctx.strokeStyle = `rgba(20, 15, 10, ${0.4 + Math.random() * 0.3})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Generate snow texture with sparkle and variation
function createSnowTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Base snow color
  ctx.fillStyle = "#f0f8ff";
  ctx.fillRect(0, 0, size, size);

  // Add snow texture variation
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const variation = (Math.random() - 0.5) * 20;
    data[i] += variation;     // R
    data[i + 1] += variation + 5; // G (slightly more blue)
    data[i + 2] += variation + 10; // B
  }

  ctx.putImageData(imageData, 0, 0);

  // Add sparkle highlights
  for (let i = 0; i < size * 2; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const radius = 0.5 + Math.random() * 1.5;

    ctx.fillStyle = `rgba(255, 255, 255, ${0.6 + Math.random() * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Helper function to adjust color brightness
function adjustBrightness(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const nr = Math.min(255, Math.floor(r * factor));
  const ng = Math.min(255, Math.floor(g * factor));
  const nb = Math.min(255, Math.floor(b * factor));

  return `rgb(${nr}, ${ng}, ${nb})`;
}

const TerrainViewer = forwardRef<TerrainViewerHandle, Props>(
  function TerrainViewer(
    { terrain, projectId, onHover, exaggeration, colorMode, measureMode, placeData, showPlace, boundaryCorners, groundwaterData }: Props,
    ref
  ) {
  const mountRef = useRef<HTMLDivElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const scaleBarRef = useRef<HTMLDivElement>(null);
  const scaleLabelRef = useRef<HTMLSpanElement>(null);
  const measureReadoutRef = useRef<HTMLDivElement>(null);

  // Persistent three.js state across renders, populated by the setup effect.
  const stateRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    mesh: THREE.Mesh;
    shadedMaterial: THREE.MeshStandardMaterial;
    wireLines: THREE.LineSegments;
    contourGroup: THREE.Group;
    measureGroup: THREE.Group;
    placeGroup: THREE.Group;
    boundaryGroup: THREE.Group;
    groundwaterGroup: THREE.Group;
    pedestalGroup: THREE.Group;
    waterGroup: THREE.Group;
    measurePoints: THREE.Vector3[]; // true (un-exaggerated) world points
    measureModeActive: boolean;
    center: { cx: number; cy: number; cz: number };
    maxDim: number;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  } | null>(null);

  function clearMeasurementInternal() {
    const st = stateRef.current;
    if (!st) return;
    st.measurePoints = [];
    st.measureGroup.clear();
    if (measureReadoutRef.current) measureReadoutRef.current.style.display = "none";
  }

  // --- one-time scene setup, re-runs only when a genuinely new terrain loads ---
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#c8d4d0"); // Soft sage background like the reference
    scene.fog = new THREE.Fog(0xc8d4d0, 1, 6000);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 8000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    let cx = 0, cy = 0, cz = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of terrain.vertices) {
      cx += v[0]; cy += v[1]; cz += v[2];
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
    }
    cx /= terrain.vertices.length; cy /= terrain.vertices.length; cz /= terrain.vertices.length;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(terrain.vertices.length * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(terrain.vertices.length * 3), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrain.faces.flat()), 1));

    const shadedMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geometry, shadedMaterial);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);

    const wireGeom = new THREE.BufferGeometry();
    const wireMat = new THREE.LineBasicMaterial({ color: 0x0b0f14, transparent: true, opacity: 0.2 });
    const wireLines = new THREE.LineSegments(wireGeom, wireMat);
    scene.add(wireLines);

    const contourGroup = new THREE.Group();
    scene.add(contourGroup);

    const measureGroup = new THREE.Group();
    scene.add(measureGroup);

    const placeGroup = new THREE.Group();
    scene.add(placeGroup);

    const boundaryGroup = new THREE.Group();
    scene.add(boundaryGroup);

    const groundwaterGroup = new THREE.Group();
    scene.add(groundwaterGroup);

    const pedestalGroup = new THREE.Group();
    scene.add(pedestalGroup);

    const waterGroup = new THREE.Group();
    scene.add(waterGroup);

    // Ground plane, purely so shadows have something to fall onto beyond the mesh edges
    const groundGeom = new THREE.PlaneGeometry(20000, 20000);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.18 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    scene.add(ground);

    // Improved lighting for photorealistic look
    const hemi = new THREE.HemisphereLight(0xe8f0f5, 0x6b7c6f, 0.6);
    scene.add(hemi);

    // Main sun - warm natural light
    const sun = new THREE.DirectionalLight(0xfff8e7, 1.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    // Fill light to soften shadows
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.z, 10);

    // Fill light to soften shadows
    const fill = new THREE.DirectionalLight(0xb8d4e8, 0.4);
    fill.position.set(-maxDim * 0.5, maxDim * 0.6, -maxDim * 0.3);
    scene.add(fill);

    sun.position.set(maxDim * 0.7, maxDim * 1.2, maxDim * 0.5);
    sun.shadow.camera.left = -maxDim * 1.2;
    sun.shadow.camera.right = maxDim * 1.2;
    sun.shadow.camera.top = maxDim * 1.2;
    sun.shadow.camera.bottom = -maxDim * 1.2;
    sun.shadow.camera.far = maxDim * 5;
    sun.shadow.camera.updateProjectionMatrix();

    camera.position.set(maxDim * 0.9, maxDim * 0.75, maxDim * 0.9);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(maxDim / 2000, 0.02);
    camera.updateProjectionMatrix();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = Math.max(maxDim * 0.015, 0.1);
    controls.zoomSpeed = 0.7;

    stateRef.current = {
      scene, camera, renderer, controls, mesh, shadedMaterial,
      wireLines, contourGroup, measureGroup, placeGroup, boundaryGroup, groundwaterGroup,
      pedestalGroup, waterGroup,
      measurePoints: [], measureModeActive: measureMode,
      center: { cx, cy, cz }, maxDim, bounds: { minX, maxX, minY, maxY },
    };

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function getTrueHitPoint(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
      const st = stateRef.current;
      if (!st) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObjects([mesh], true)[0];
      if (!hit) return null;
      const exag = (mesh.userData.exaggeration as number) || 1;
      return new THREE.Vector3(hit.point.x, hit.point.y / exag, hit.point.z);
    }

    function handlePointerMove(e: PointerEvent) {
      const st = stateRef.current;
      if (!st) return;
      const truePoint = getTrueHitPoint(e);
      if (truePoint) {
        onHover({ x: truePoint.x + st.center.cx, y: -truePoint.z + st.center.cy, z: truePoint.y + st.center.cz });
      } else {
        onHover(null);
      }
    }
    function handlePointerLeave() {
      onHover(null);
    }
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

    function updateMeasureVisuals() {
      const st = stateRef.current;
      if (!st) return;
      const exag = (mesh.userData.exaggeration as number) || 1;
      st.measureGroup.clear();

      const sphereGeom = new THREE.SphereGeometry(Math.max(st.maxDim * 0.008, 0.08), 12, 12);
      const sphereMat = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
      st.measurePoints.forEach((p) => {
        const marker = new THREE.Mesh(sphereGeom, sphereMat);
        marker.position.set(p.x, p.y * exag, p.z);
        marker.renderOrder = 999; // always draw on top - a marker hidden behind a
        // building's opaque geometry looked exactly like "the click did nothing"
        st.measureGroup.add(marker);
      });

      if (st.measurePoints.length === 2) {
        const [a, b] = st.measurePoints;
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y * exag, a.z),
          new THREE.Vector3(b.x, b.y * exag, b.z),
        ]);
        const lineMat = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
        const line = new THREE.Line(lineGeom, lineMat);
        line.renderOrder = 999;
        st.measureGroup.add(line);

        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dy = b.y - a.y;
        const horizontal = Math.sqrt(dx * dx + dz * dz);
        const distance3d = Math.sqrt(dx * dx + dz * dz + dy * dy);
        const slopePct = horizontal > 1e-6 ? (Math.abs(dy) / horizontal) * 100 : 0;

        if (measureReadoutRef.current) {
          measureReadoutRef.current.style.display = "block";
          measureReadoutRef.current.innerHTML =
            `<div class="readout" style="font-size:11px;line-height:1.5">` +
            `Horizontal: ${horizontal.toFixed(2)} m<br/>` +
            `Elevation Δ: ${dy >= 0 ? "+" : ""}${dy.toFixed(2)} m<br/>` +
            `Direct: ${distance3d.toFixed(2)} m<br/>` +
            `Slope: ${slopePct.toFixed(1)}%` +
            `</div>`;
        }
      } else if (measureReadoutRef.current) {
        measureReadoutRef.current.style.display = "none";
      }
    }

    // Using a raw "click" event here was a real bug: the browser fires "click"
    // on pointerup as long as it started on the same element, REGARDLESS of how
    // far the pointer moved in between - so orbiting the camera (a mousedown-
    // drag-mouseup on this same canvas) also fired "click" and silently dropped
    // an unwanted measurement point at wherever the drag happened to end. Fixed
    // by tracking the actual down/up positions and only counting it as a real
    // "click to place a point" when the pointer barely moved between them.
    let pointerDownPos: { x: number; y: number } | null = null;
    let pointerDownTime = 0;
    // 5px was too tight - ordinary hand tremor during a genuine click easily
    // exceeds that, especially on a trackpad or high-DPI mouse, which would
    // silently misclassify every real click as a drag (no console error,
    // just... nothing happens). Looser threshold, plus a time-based
    // fallback: a very quick press-release is almost certainly a click
    // even if it moved a few more pixels than that.
    const DRAG_THRESHOLD_PX = 14;
    const QUICK_CLICK_MS = 300;

    function handlePointerDown(e: PointerEvent) {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      pointerDownTime = performance.now();
    }

    function handlePointerUp(e: PointerEvent) {
      const st = stateRef.current;
      if (!st || !st.measureModeActive || !pointerDownPos) {
        pointerDownPos = null;
        return;
      }
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      const elapsedMs = performance.now() - pointerDownTime;
      pointerDownPos = null;
      const movedPx = Math.sqrt(dx * dx + dy * dy);
      const wasQuick = elapsedMs < QUICK_CLICK_MS;
      if (movedPx > DRAG_THRESHOLD_PX && !wasQuick) return; // a real orbit drag, not a click

      const truePoint = getTrueHitPoint(e);
      if (!truePoint) return;
      if (st.measurePoints.length >= 2) {
        st.measurePoints = [truePoint];
      } else {
        st.measurePoints.push(truePoint);
      }
      updateMeasureVisuals();
    }
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    function handleResize() {
      if (!mount) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(mount);

    const northDir = new THREE.Vector3(0, 0, -1);
    function updateHud() {
      if (compassRef.current) {
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        camDir.y = 0;
        if (camDir.lengthSq() > 1e-6) {
          camDir.normalize();
          const angle = Math.atan2(camDir.x, -camDir.z) - Math.atan2(northDir.x, -northDir.z);
          compassRef.current.style.transform = `rotate(${-angle}rad)`;
        }
      }
      if (scaleBarRef.current && scaleLabelRef.current) {
        const distance = camera.position.distanceTo(controls.target);
        const fovRad = (camera.fov * Math.PI) / 180;
        const worldPerPixel = (2 * distance * Math.tan(fovRad / 2)) / renderer.domElement.clientHeight;
        const targetPx = 110;
        let chosen = SCALE_STEPS[0];
        for (const step of SCALE_STEPS) {
          if (step / worldPerPixel <= targetPx * 1.6) chosen = step;
        }
        const px = Math.max(chosen / worldPerPixel, 4);
        scaleBarRef.current.style.width = `${px}px`;
        scaleLabelRef.current.textContent = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
      }
    }

    let frameId: number;
    function animate() {
      frameId = requestAnimationFrame(animate);
      controls.update();
      updateHud();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      controls.dispose();
      geometry.dispose();
      shadedMaterial.dispose();
      wireGeom.dispose();
      wireMat.dispose();
      groundGeom.dispose();
      groundMat.dispose();
      contourGroup.children.forEach((c) => {
        if (c instanceof THREE.LineSegments) {
          c.geometry.dispose();
          (c.material as THREE.Material).dispose();
        }
      });
      placeGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      boundaryGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      groundwaterGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      pedestalGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      waterGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      stateRef.current = null;
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain]);

  // Keep the click handler's view of measureMode fresh without re-running scene setup.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    st.measureModeActive = measureMode;
    if (!measureMode) clearMeasurementInternal();
  }, [measureMode]);

  // --- geometry + color/material update: runs on exaggeration/colorMode changes ---
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const { mesh, wireLines, contourGroup, measureGroup, measurePoints, center, shadedMaterial } = st;
    const { cx, cy, cz } = center;
    const geometry = mesh.geometry;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = geometry.attributes.color as THREE.BufferAttribute;

    const { vertices, elevation_min, elevation_max } = terrain;
    const zRange = Math.max(elevation_max - elevation_min, 1e-6);

    vertices.forEach((v, i) => {
      posAttr.setXYZ(i, v[0] - cx, (v[2] - cz) * exaggeration, -(v[1] - cy));
    });
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    mesh.userData.exaggeration = exaggeration;

    mesh.material = shadedMaterial;
    const normalAttr = geometry.attributes.normal as THREE.BufferAttribute;
    const up = new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3();
    for (let i = 0; i < vertices.length; i++) {
      let color: THREE.Color;
      if (colorMode === "slope") {
        n.set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
        const slopeDeg = (Math.acos(Math.min(1, Math.max(-1, n.dot(up)))) * 180) / Math.PI;
        const t = Math.min(slopeDeg / SLOPE_MAX_DEG, 1);
        color = SLOPE_FLAT.clone().lerp(SLOPE_STEEP, t);
      } else {
        // Photorealistic height-based terrain: grass → rock → snow
        const elevationT = (vertices[i][2] - elevation_min) / zRange;
        if (elevationT < 0.5) {
          color = TERRAIN_GRASS;
        } else if (elevationT < 0.75) {
          const t = (elevationT - 0.5) / 0.25;
          color = TERRAIN_GRASS.clone().lerp(TERRAIN_ROCK, t);
        } else {
          const t = (elevationT - 0.75) / 0.25;
          color = TERRAIN_ROCK.clone().lerp(TERRAIN_SNOW, t);
        }
      }
      colorAttr.setXYZ(i, color.r, color.g, color.b);
    }
    colorAttr.needsUpdate = true;

    mesh.visible = true;
    wireLines.geometry.dispose();
    wireLines.geometry = new THREE.WireframeGeometry(geometry);
    wireLines.visible = true;

    contourGroup.children.forEach((c) => {
      if (c instanceof THREE.LineSegments) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    });
    contourGroup.clear();
    contourGroup.visible = true;
    {
      const contourMat = new THREE.LineBasicMaterial({ color: 0xe6edf3, transparent: true, opacity: 0.5 });
      terrain.contours.forEach((c) => {
        const linePositions: number[] = [];
        c.segments.forEach((seg) => {
          seg.forEach((pt) => {
            linePositions.push(pt[0] - cx, (pt[2] - cz) * exaggeration + 0.03, -(pt[1] - cy));
          });
        });
        if (linePositions.length === 0) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
        contourGroup.add(new THREE.LineSegments(g, contourMat));
      });
    }

    measureGroup.clear();
    if (measurePoints.length > 0) {
      const sphereGeom = new THREE.SphereGeometry(Math.max(st.maxDim * 0.008, 0.08), 12, 12);
      const sphereMat = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
      measurePoints.forEach((p) => {
        const marker = new THREE.Mesh(sphereGeom, sphereMat);
        marker.position.set(p.x, p.y * exaggeration, p.z);
        marker.renderOrder = 999;
        measureGroup.add(marker);
      });
      if (measurePoints.length === 2) {
        const [a, b] = measurePoints;
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y * exaggeration, a.z),
          new THREE.Vector3(b.x, b.y * exaggeration, b.z),
        ]);
        const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false }));
        line.renderOrder = 999;
        measureGroup.add(line);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain, exaggeration, colorMode, projectId]);

  // --- Place mode: buildings + roads, rebuilt whenever the data or exaggeration/visibility changes ---
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const { placeGroup, center } = st;
    const { cx, cy, cz } = center;

    placeGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    placeGroup.clear();

    if (!showPlace || !placeData) {
      console.log("Place mode:", { showPlace, hasPlaceData: !!placeData });
      return;
    }

    console.log("Rendering Place mode:", {
      buildings: placeData.buildings.length,
      roads: placeData.roads.length
    });

    placeData.buildings.forEach((b) => {
      if (b.footprint.length < 3) return;
      // Shape is built in the horizontal plane using (local_x, local_y) directly -
      // NOT pre-negated - because ExtrudeGeometry + rotateX(-90deg) already applies
      // that sign flip itself (verified numerically: rotateX(-90) maps shape.y -> -world.Z,
      // so an un-negated shape.y lands at the same world.Z the terrain mesh uses,
      // -(local_y - cy); pre-negating here would double-flip and mirror buildings
      // north-south relative to the terrain).
      const shape = new THREE.Shape(b.footprint.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      // Building height is real, physical geometry - deliberately NOT scaled by
      // the terrain's vertical exaggeration (exaggerating relief is about making
      // subtle elevation *differences* visible, not about inflating a building's
      // actual height). Only the base position follows the exaggerated terrain.
      const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
      extrudeGeom.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({
        color: b.height_source === "OSM_TAG" ? BUILDING_COLOR_REAL : BUILDING_COLOR_ESTIMATED,
        roughness: 0.85,
        // OSM way winding order isn't guaranteed consistent - DoubleSide avoids
        // faces vanishing from certain viewing angles on backwards-wound polygons.
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(extrudeGeom, material);
      mesh.position.y = (b.base_elevation - cz) * exaggeration;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      placeGroup.add(mesh);
    });

    placeData.roads.forEach((r) => {
      if (r.points.length < 2) return;
      const pts = r.points.map(
        ([x, y, z]) => new THREE.Vector3(x - cx, (z - cz) * exaggeration + 0.05, -(y - cy))
      );
      const { width, color, opacity } = roadStyle(r.road_type);
      const geom = buildRoadRibbon(pts, width);
      const material = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      });
      const ribbon = new THREE.Mesh(geom, material);
      ribbon.renderOrder = 1; // draw after terrain so it doesn't z-fight with the surface underneath
      placeGroup.add(ribbon);
    });
  }, [placeData, showPlace, exaggeration]);

  // --- Boundary outline: highlights the actual selected/surveyed site against
  // surrounding OSM context in Place mode, and is harmless/useful in Terrain
  // mode too. Draped onto real terrain height at each corner (nearest-neighbor
  // sample), not a flat line floating at a fixed height.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const { boundaryGroup, center } = st;
    const { cx, cy, cz } = center;

    boundaryGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    boundaryGroup.clear();

    if (!boundaryCorners || boundaryCorners.length < 3) return;

    const width = Math.max(st.maxDim * 0.006, 0.15);
    const pts = boundaryCorners.map(([x, y]) => {
      const z = sampleTerrainHeight(x, y, terrain.vertices);
      return new THREE.Vector3(x - cx, (z - cz) * exaggeration + 0.08, -(y - cy));
    });
    // Close the loop if it isn't already (first point repeated at the end).
    const first = pts[0], last = pts[pts.length - 1];
    if (first.distanceTo(last) > 1e-6) pts.push(first.clone());

    const geom = buildRoadRibbon(pts, width);
    const material = new THREE.MeshBasicMaterial({
      color: BOUNDARY_COLOR, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthTest: false,
    });
    const ribbon = new THREE.Mesh(geom, material);
    ribbon.renderOrder = 998; // just under measurement markers, above everything else
    boundaryGroup.add(ribbon);
  }, [terrain, boundaryCorners, exaggeration]);

  // --- Groundwater marker: a real measured depth at the nearest known well,
  // NOT a value for the exact site. Rendered as a thin rod from the terrain
  // surface down to the real measured depth, drawn "through" the terrain
  // (depthTest off) since the whole point is showing what's below ground -
  // otherwise it would be invisible, hidden inside the mesh by definition.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const { groundwaterGroup, center } = st;
    const { cx, cy, cz } = center;

    groundwaterGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    groundwaterGroup.clear();

    if (!groundwaterData || !groundwaterData.available) return;

    const localX = groundwaterData.station_local_x - cx;
    const localZ = -(groundwaterData.station_local_y - cy);
    const surfaceElev = sampleTerrainHeight(groundwaterData.station_local_x, groundwaterData.station_local_y, terrain.vertices);
    const depth = groundwaterData.latest_reading.depth_below_ground_m;

    const topY = (surfaceElev - cz) * exaggeration;
    const bottomY = (surfaceElev - depth - cz) * exaggeration;
    const rodHeight = Math.max(topY - bottomY, 0.01);
    const radius = Math.max(st.maxDim * 0.004, 0.06);

    const rodGeom = new THREE.CylinderGeometry(radius, radius, rodHeight, 12);
    const rodMat = new THREE.MeshBasicMaterial({
      color: GROUNDWATER_COLOR, transparent: true, opacity: 0.85, depthTest: false,
    });
    const rod = new THREE.Mesh(rodGeom, rodMat);
    rod.position.set(localX, (topY + bottomY) / 2, localZ);
    rod.renderOrder = 997;
    groundwaterGroup.add(rod);

    const capGeom = new THREE.SphereGeometry(radius * 2.2, 12, 12);
    const capMat = new THREE.MeshBasicMaterial({ color: GROUNDWATER_COLOR, depthTest: false });
    const topCap = new THREE.Mesh(capGeom, capMat);
    topCap.position.set(localX, topY, localZ);
    topCap.renderOrder = 997;
    groundwaterGroup.add(topCap);

    const bottomCap = new THREE.Mesh(capGeom, capMat.clone());
    bottomCap.position.set(localX, bottomY, localZ);
    bottomCap.renderOrder = 997;
    groundwaterGroup.add(bottomCap);
  }, [terrain, groundwaterData, exaggeration]);

  // --- Photorealistic pedestal base with geological layers + optional water plane ---
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const { pedestalGroup, waterGroup, center, bounds } = st;
    const { cx, cy, cz } = center;

    // Clean up existing geometry
    pedestalGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
    });
    pedestalGroup.clear();

    waterGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
    });
    waterGroup.clear();

    const { vertices, elevation_min, elevation_max } = terrain;
    if (vertices.length < 3) return;

    // Find terrain boundary using the edge-detection algorithm
    const edgeMap = new Map<string, number>();
    terrain.faces.forEach((face) => {
      const edges = [
        [face[0], face[1]].sort((a, b) => a - b),
        [face[1], face[2]].sort((a, b) => a - b),
        [face[2], face[0]].sort((a, b) => a - b),
      ];
      edges.forEach((edge) => {
        const key = `${edge[0]},${edge[1]}`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
      });
    });

    const boundaryEdges: [number, number][] = [];
    edgeMap.forEach((count, key) => {
      if (count === 1) {
        const [a, b] = key.split(",").map(Number);
        boundaryEdges.push([a, b]);
      }
    });

    if (boundaryEdges.length < 3) return;

    // Build ordered boundary loop
    const boundaryLoop: number[] = [boundaryEdges[0][0], boundaryEdges[0][1]];
    const used = new Set([0]);
    while (boundaryLoop.length < boundaryEdges.length) {
      const last = boundaryLoop[boundaryLoop.length - 1];
      let found = false;
      for (let i = 0; i < boundaryEdges.length; i++) {
        if (used.has(i)) continue;
        const [a, b] = boundaryEdges[i];
        if (a === last) {
          boundaryLoop.push(b);
          used.add(i);
          found = true;
          break;
        } else if (b === last) {
          boundaryLoop.push(a);
          used.add(i);
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    // Create geological layer texture
    const layerTexture = createGeologicalLayerTexture(512, 512);

    // Pedestal depth - make it substantial like the reference image
    const pedestalDepth = Math.max((elevation_max - elevation_min) * exaggeration * 0.8, st.maxDim * 0.15);
    const baseY = (elevation_min - cz) * exaggeration - pedestalDepth;

    // Create vertical walls with geological texture for each boundary edge
    boundaryLoop.forEach((idx, i) => {
      const nextIdx = boundaryLoop[(i + 1) % boundaryLoop.length];
      const v1 = vertices[idx];
      const v2 = vertices[nextIdx];

      const p1 = new THREE.Vector3(v1[0] - cx, (v1[2] - cz) * exaggeration, -(v1[1] - cy));
      const p2 = new THREE.Vector3(v2[0] - cx, (v2[2] - cz) * exaggeration, -(v2[1] - cy));
      const p3 = new THREE.Vector3(v2[0] - cx, baseY, -(v2[1] - cy));
      const p4 = new THREE.Vector3(v1[0] - cx, baseY, -(v1[1] - cy));

      const wallGeom = new THREE.BufferGeometry();
      wallGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [
            p1.x, p1.y, p1.z,
            p2.x, p2.y, p2.z,
            p3.x, p3.y, p3.z,
            p4.x, p4.y, p4.z,
          ],
          3
        )
      );

      // UV mapping for geological layers (vertical striations)
      const edgeLength = p1.distanceTo(p2);
      wallGeom.setAttribute(
        "uv",
        new THREE.Float32BufferAttribute(
          [
            0, 1,
            edgeLength / 50, 1,
            edgeLength / 50, 0,
            0, 0,
          ],
          2
        )
      );

      wallGeom.setIndex([0, 1, 2, 0, 2, 3]);
      wallGeom.computeVertexNormals();

      const wallMat = new THREE.MeshStandardMaterial({
        map: layerTexture,
        roughness: 0.95,
        metalness: 0,
        side: THREE.FrontSide,
      });

      const wall = new THREE.Mesh(wallGeom, wallMat);
      wall.castShadow = true;
      wall.receiveShadow = true;
      pedestalGroup.add(wall);
    });

    // Bottom cap (darker bedrock)
    const bottomShape = new THREE.Shape(
      boundaryLoop.map((idx) => {
        const v = vertices[idx];
        return new THREE.Vector2(v[0] - cx, -(v[1] - cy));
      })
    );
    const bottomGeom = new THREE.ShapeGeometry(bottomShape);
    bottomGeom.rotateX(-Math.PI / 2);
    bottomGeom.translate(0, baseY, 0);

    const bottomMat = new THREE.MeshStandardMaterial({
      color: 0x3a3028,
      roughness: 0.95,
      metalness: 0,
    });
    const bottom = new THREE.Mesh(bottomGeom, bottomMat);
    bottom.receiveShadow = true;
    pedestalGroup.add(bottom);

    // Optional water plane for low-lying areas with reflective shader
    const waterThreshold = elevation_min + (elevation_max - elevation_min) * 0.15;
    if (elevation_min < waterThreshold) {
      const waterY = (waterThreshold - cz) * exaggeration + 0.02;
      const waterSize = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 1.5;

      const waterGeom = new THREE.PlaneGeometry(waterSize, waterSize, 64, 64);

      // Enhanced reflective water material
      const waterMat = new THREE.MeshPhysicalMaterial({
        color: 0x1a5f8f,
        transparent: true,
        opacity: 0.7,
        roughness: 0.05,
        metalness: 0.1,
        reflectivity: 0.9,
        clearcoat: 1.0,
        clearcoatRoughness: 0.1,
        transmission: 0.3,
        ior: 1.33, // index of refraction for water
      });

      const water = new THREE.Mesh(waterGeom, waterMat);
      water.rotation.x = -Math.PI / 2;
      water.position.y = waterY;
      water.receiveShadow = true;

      // Add subtle wave animation to vertices
      const posAttr = waterGeom.attributes.position;
      const time = Date.now() * 0.0001;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const y = posAttr.getY(i);
        const wave = Math.sin(x * 0.1 + time) * 0.05 + Math.cos(y * 0.1 + time * 0.7) * 0.05;
        posAttr.setZ(i, wave);
      }
      posAttr.needsUpdate = true;
      waterGeom.computeVertexNormals();

      waterGroup.add(water);
    }
  }, [terrain, exaggeration]);

  useImperativeHandle(ref, () => ({
    setView(preset: ViewPreset) {
      const st = stateRef.current;
      if (!st) return;
      const { camera, controls, maxDim } = st;
      controls.target.set(0, 0, 0);
      if (preset === "top") {
        camera.position.set(0.001, maxDim * 1.6, 0.001);
      } else if (preset === "side") {
        camera.position.set(maxDim * 1.4, maxDim * 0.15, 0.001);
      } else {
        camera.position.set(maxDim * 0.9, maxDim * 0.75, maxDim * 0.9);
      }
      camera.lookAt(0, 0, 0);
    },
    clearMeasurement() {
      clearMeasurementInternal();
    },
  }));

  return (
    <div ref={mountRef} className="w-full h-full blueprint-grid relative">
      <div className="absolute bottom-4 left-4 w-11 h-11 rounded-full bg-panel/85 border border-border flex items-center justify-center pointer-events-none">
        <div ref={compassRef} className="relative w-8 h-8" style={{ transition: "transform 0.05s linear" }}>
          <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[10px] font-semibold text-amber">N</span>
          <svg viewBox="0 0 32 32" className="w-8 h-8">
            <path d="M16 4 L20 16 L16 13 L12 16 Z" fill="#E8A33D" />
            <path d="M16 28 L12 16 L16 19 L20 16 Z" fill="#7C8B99" />
          </svg>
        </div>
      </div>
      <div className="absolute bottom-4 left-20 pointer-events-none">
        <div ref={scaleBarRef} className="h-1 bg-ink/80 border-x border-ink/80" style={{ width: 60 }} />
        <span ref={scaleLabelRef} className="readout text-[10px] text-ink/70">
          -
        </span>
        <div className="text-[9px] text-muted">approx., at view center</div>
      </div>
      <div
        ref={measureReadoutRef}
        className="absolute bottom-4 right-4 bg-panel/90 border border-amber/40 rounded-lg px-3 py-2 pointer-events-none"
        style={{ display: "none" }}
      />
    </div>
  );
});

export default TerrainViewer;
