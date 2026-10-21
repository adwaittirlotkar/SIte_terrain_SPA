"""
Optional PyQGIS-based raster processing (currently: hillshade generation).

IMPORTANT - read before assuming this "just works":
PyQGIS is NOT a pip package. It's the Python bindings bundled inside a full
QGIS Desktop installation, and importing `qgis.core` only succeeds if this
process is running with QGIS's own Python environment / native libraries
available - a normal `pip install -r requirements.txt` venv will never see
it. See the README's "PyQGIS Setup (optional)" section for how to point
this backend at a real QGIS install on your machine.

This module is deliberately never imported at app startup (see main.py -
the import happens lazily, inside the one endpoint that needs it), so a
server with no QGIS installed keeps working normally for everything else.
Every function here raises QgisNotAvailableError with a specific, actionable
message on failure rather than crashing - that error is what the hillshade
endpoint turns into a clean HTTP response.

HONESTY NOTE: the QGIS-specific parts of this file (_init_qgis,
generate_hillshade) follow the standard, documented pattern for headless
PyQGIS scripting, but have not been run against a real QGIS install by
whoever wrote this (an AI assistant with no QGIS available to test against).
The GeoTIFF-to-PNG conversion at the bottom uses only rasterio + Pillow and
is a much more standard, lower-risk operation.
"""

import os
import sys
from typing import Optional

import numpy as np
import rasterio
from PIL import Image


class QgisNotAvailableError(Exception):
    pass


_qgis_initialized = False
_qgs_app = None  # keeps the QgsApplication instance alive for the process lifetime


def _init_qgis() -> None:
    global _qgis_initialized, _qgs_app
    if _qgis_initialized:
        return

    qgis_prefix = os.environ.get("QGIS_PREFIX_PATH")
    if not qgis_prefix:
        raise QgisNotAvailableError(
            "QGIS_PREFIX_PATH environment variable is not set. On Windows this is "
            "usually something like 'C:\\Program Files\\QGIS 3.34\\apps\\qgis'. "
            "See the README's 'PyQGIS Setup (optional)' section."
        )

    try:
        from qgis.core import QgsApplication
    except ImportError as e:
        raise QgisNotAvailableError(
            "Could not import qgis.core. This almost always means this backend process "
            "is running under a normal Python venv instead of QGIS's own bundled Python "
            f"environment. Original error: {e}"
        )

    QgsApplication.setPrefixPath(qgis_prefix, True)
    app = QgsApplication([], False)
    app.initQgis()

    # 'processing' is a QGIS *plugin*, not part of qgis.core - its Python module
    # lives under <prefix>/python/plugins, which isn't on sys.path automatically
    # even when qgis.core imports fine. This is a well-known, specific gap in
    # headless PyQGIS scripting, not a general PyQGIS setup problem.
    plugins_path = os.path.join(qgis_prefix, "python", "plugins")
    if os.path.isdir(plugins_path) and plugins_path not in sys.path:
        sys.path.append(plugins_path)

    try:
        import processing  # noqa: F401  (imported for side effect: registers the provider)
        from processing.core.Processing import Processing

        Processing.initialize()
    except ImportError as e:
        raise QgisNotAvailableError(
            f"QGIS core loaded, but the 'processing' framework (needed for the gdal:hillshade "
            f"algorithm) could not be initialized: {e}. Looked for the plugin at "
            f"'{plugins_path}' ({'exists' if os.path.isdir(plugins_path) else 'DOES NOT EXIST'}) "
            f"- if that path doesn't exist, check your QGIS install for where the 'processing' "
            f"plugin folder actually lives and it may be under a different subfolder name."
        )

    _qgs_app = app
    _qgis_initialized = True


def generate_hillshade(
    dem_path: str, out_path: str, azimuth: float = 315.0, altitude: float = 45.0, z_factor: float = 1.0
) -> str:
    """
    Runs QGIS's native GDAL hillshade algorithm on a DEM GeoTIFF and writes
    the result (a single-band shaded-relief GeoTIFF) to out_path.
    """
    _init_qgis()
    import processing

    result = processing.run(
        "gdal:hillshade",
        {
            "INPUT": dem_path,
            "BAND": 1,
            "Z_FACTOR": z_factor,
            "AZIMUTH": azimuth,
            "ALTITUDE": altitude,
            "OUTPUT": out_path,
        },
    )
    return result["OUTPUT"]


def geotiff_to_png(tif_path: str, png_path: str) -> str:
    """
    Converts a single-band GeoTIFF (e.g. a hillshade output) into a plain
    grayscale PNG for the browser to load as a texture. This part doesn't
    touch QGIS at all - just rasterio + Pillow, both already dependencies.
    """
    with rasterio.open(tif_path) as src:
        data = src.read(1).astype(np.float32)
        nodata = src.nodata

    if nodata is not None:
        valid = data[data != nodata]
    else:
        valid = data

    if valid.size == 0:
        raise QgisNotAvailableError("Hillshade output contained no valid data to render.")

    vmin, vmax = float(valid.min()), float(valid.max())
    rng = max(vmax - vmin, 1e-6)
    normalized = np.clip((data - vmin) / rng, 0, 1)
    if nodata is not None:
        normalized[data == nodata] = 0

    img = Image.fromarray((normalized * 255).astype(np.uint8), mode="L")
    img.save(png_path)
    return png_path
