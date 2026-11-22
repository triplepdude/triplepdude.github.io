"""Cone excitations for the colour blind test, from the published constants.

The test reads the dot colours off each plate and turns them into L, M and S
cone excitations with this matrix, so it checks the plates against the
standards rather than against the page's own arithmetic:

  linear sRGB -> CIE 1931 XYZ: IEC 61966-2-1 (sRGB), D65
  XYZ -> L, M, S:              Smith and Pokorny (1975), Vision Research 15,
                               161-171 (S row scaled arbitrarily; only ratios
                               of S are used)

As a check of the constants, the script also derives the copunctal points,
where the protan, deutan and tritan confusion lines meet in the CIE 1931
chromaticity diagram. Published values: protan (0.7465, 0.2535), deutan
(1.4000, -0.4000), tritan (0.1748, 0.0000).

Run: python3 cones.py > cones.json
"""
import json
import numpy as np

RGB_TO_XYZ = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
XYZ_TO_LMS = np.array([[0.15514, 0.54312, -0.03286], [-0.15514, 0.45684, 0.03286], [0.0, 0.0, 0.00801]])
RGB_TO_LMS = XYZ_TO_LMS @ RGB_TO_XYZ

copunctal = {}
for k, name in enumerate(['protan', 'deutan', 'tritan']):
    # A change in one cone type only, seen in XYZ: its chromaticity is the
    # point every confusion line of that type passes through.
    e = np.zeros(3)
    e[k] = 1.0
    X, Y, Z = np.linalg.solve(XYZ_TO_LMS, e)
    copunctal[name] = [round(X / (X + Y + Z), 4), round(Y / (X + Y + Z), 4)]

assert copunctal == {'protan': [0.7465, 0.2535], 'deutan': [1.3999, -0.3999], 'tritan': [0.1748, 0.0]}, copunctal

print(json.dumps({
    'rgb_to_lms': [[float(v) for v in row] for row in RGB_TO_LMS],
    'copunctal': copunctal,
}, indent=1))
