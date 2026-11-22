"""Expected sRGB colours of the white screen's colour temperatures.

Computed independently of the page with the colour-science package
(pip install colour-science): the Planckian locus by integrating Planck's law
against the CIE 1931 2-degree colour matching functions (the page uses
Krystek's 1985 approximation instead), and the CIE daylight locus from
colour's own implementation of CIE 015, with nominal temperatures corrected
for the change in c2 (6500 K is the CCT 6504 K of D65). The chromaticity is
converted to linear sRGB with colour's sRGB colourspace and divided, channel
by channel, by the result for 6500 K: the daylight formula puts D65 at
(0.31272, 0.32913), a rounding away from the sRGB white point (0.3127,
0.3290), and the page treats 6500 K as exactly the screen's white, #FFFFFF.
Then the brightest channel is scaled to 1, the result multiplied by the
brightness and encoded with the sRGB curve.
Run: python3 colour-temperature.py > colour-temperature.json
"""
import json
import numpy as np
import colour

CMFS = colour.MSDS_CMFS['CIE 1931 2 Degree Standard Observer']
SRGB = colour.RGB_COLOURSPACES['sRGB']


def xy_for(kelvin):
    if kelvin < 4000:
        sd = colour.sd_blackbody(kelvin, colour.SpectralShape(360, 830, 1))
        return colour.XYZ_to_xy(colour.sd_to_XYZ(sd, CMFS))
    return colour.temperature.CCT_to_xy_CIE_D(kelvin * 1.4388 / 1.4380)


def linear_rgb(kelvin):
    x, y = xy_for(kelvin)
    return np.array(SRGB.matrix_XYZ_to_RGB) @ np.array([x / y, 1.0, (1 - x - y) / y])


def srgb8(kelvin, brightness):
    rgb = linear_rgb(kelvin) / linear_rgb(6500)
    rgb = np.clip(rgb / rgb.max(), 0, None) * brightness / 100
    return [int(v) for v in np.round(colour.cctf_encoding(rgb, 'sRGB') * 255)]


cases = [(k, 100) for k in range(1900, 10001, 100)] + [(2700, 40), (6500, 50), (5000, 25), (1900, 10), (9300, 75)]
print(json.dumps([{'kelvin': k, 'brightness': b, 'rgb': srgb8(k, b)} for k, b in cases], indent=1))
