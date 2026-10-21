"""
Generates a synthetic survey.dxf so you can test the whole pipeline before
you have real SPA survey data.

Creates:
  - A closed LWPOLYLINE boundary on layer "BOUNDARY"
  - A grid of POINT entities on layer "SURVEY_POINTS" with a rolling
    hill-like elevation surface (sine-based, deterministic, seeded)

Run:  python generate_sample_dxf.py
Output: ./sample.dxf
"""

import math
import ezdxf


def main():
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()

    doc.layers.add(name="BOUNDARY", color=1)
    doc.layers.add(name="SURVEY_POINTS", color=3)

    # Site boundary: a slightly irregular ~100m x 80m parcel
    boundary = [
        (0, 0), (100, 0), (110, 40), (95, 80), (10, 75), (-5, 30), (0, 0)
    ]
    msp.add_lwpolyline(boundary, dxfattribs={"layer": "BOUNDARY", "closed": True})

    # Survey point grid with a rolling terrain surface
    step = 8
    for x in range(-10, 120, step):
        for y in range(-10, 90, step):
            z = (
                18.0
                + 6.0 * math.sin(x / 30.0)
                + 4.0 * math.cos(y / 25.0)
                + 0.05 * x
            )
            msp.add_point((x, y, z), dxfattribs={"layer": "SURVEY_POINTS"})

    doc.saveas("sample.dxf")
    print("Wrote sample.dxf")


if __name__ == "__main__":
    main()
