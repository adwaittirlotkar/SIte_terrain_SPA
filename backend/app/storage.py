"""
File-based storage for the MVP.

Per the "don't build all of this at once" principle: a real project would
reach for PostgreSQL + PostGIS once there are actual spatial queries to
run. Until then, one folder per project on disk is simpler, inspectable,
and keeps the original upload file untouched for traceability.
"""

import json
import os
from typing import Any, Dict, Optional

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "projects")


def _project_dir(project_id: str) -> str:
    path = os.path.join(DATA_DIR, project_id)
    os.makedirs(path, exist_ok=True)
    return path


def save_original_file(project_id: str, filename: str, content: bytes) -> str:
    original_dir = get_original_dir(project_id)
    dest = os.path.join(original_dir, filename)
    with open(dest, "wb") as f:
        f.write(content)
    return dest


def get_original_dir(project_id: str) -> str:
    """Public (unlike _project_dir) since other modules may need to agree on
    where a project's source files live (e.g. the original uploaded DXF)."""
    original_dir = os.path.join(_project_dir(project_id), "original")
    os.makedirs(original_dir, exist_ok=True)
    return original_dir


def save_json(project_id: str, name: str, data: Dict[str, Any]) -> None:
    path = os.path.join(_project_dir(project_id), f"{name}.json")
    with open(path, "w") as f:
        json.dump(data, f)


def load_json(project_id: str, name: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(_project_dir(project_id), f"{name}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r") as f:
        return json.load(f)


def project_exists(project_id: str) -> bool:
    return os.path.isdir(os.path.join(DATA_DIR, project_id))
