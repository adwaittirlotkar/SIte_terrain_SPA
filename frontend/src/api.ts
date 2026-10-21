import { SiteData, TerrainData, BBox, PlaceData, GroundwaterData } from "./types";

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function uploadSurvey(file: File): Promise<SiteData> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  return unwrap<SiteData>(res);
}

export async function fetchLocationTerrain(bbox: BBox): Promise<SiteData> {
  const res = await fetch("/api/fetch-location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bbox),
  });
  return unwrap<SiteData>(res);
}

export async function getSite(projectId: string): Promise<SiteData> {
  const res = await fetch(`/api/site/${projectId}`);
  return unwrap<SiteData>(res);
}

export async function getTerrain(projectId: string): Promise<TerrainData> {
  const res = await fetch(`/api/terrain/${projectId}`);
  return unwrap<TerrainData>(res);
}

export async function getPlaceData(projectId: string): Promise<PlaceData> {
  const res = await fetch(`/api/place/${projectId}`);
  return unwrap<PlaceData>(res);
}

export async function getGroundwaterData(projectId: string): Promise<GroundwaterData> {
  const res = await fetch(`/api/terrain/${projectId}/groundwater`);
  return unwrap<GroundwaterData>(res);
}
