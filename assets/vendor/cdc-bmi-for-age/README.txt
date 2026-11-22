CDC extended BMI-for-age growth chart data (2022)
Licence: public domain. A work of the US federal government (Centers for
Disease Control and Prevention), free to use under CDC's "Use of Agency
Materials" policy, which asks for credit and a statement that its use does
not imply endorsement: https://www.cdc.gov/other/agencymaterials.html

Credit: BMI-for-age data: CDC, National Center for Health Statistics (2022
extended BMI-for-age charts). Use does not imply endorsement by CDC.

Source: https://www.cdc.gov/growthcharts/extended-bmi-data-files.htm
  file https://www.cdc.gov/growthcharts/data/extended-bmi/bmi-age-2022.csv
  downloaded 22 November 2026 (Last-Modified 7 May 2024), 124,895 bytes,
  sha256 7f416a213157a5209bb6cbfd1b19292510248f3f31fe43c9ff63f6d8e39f7890

bmi-age-2022.csv keeps 6 of the 35 columns of that file, every row and every
value exactly as published (438 rows: sex 1 = male, 2 = female; agemos 24 to
240.5 months, each row standing for the whole month, so 48.5 covers 48.0 up to
but not including 49.0 months):

  sex, agemos   sex and age in months
  L, M, S       the LMS parameters of the CDC 2000 BMI-for-age charts
  sigma         the dispersion used above the 95th percentile

The BMI calculator page (/bmi-calculator/) loads it only for ages 2 to 19 and
works out percentiles and z-scores as the source page describes: from L, M and
S up to the 95th percentile, and 90 + 10 x the normal distribution of
(BMI - P95) / sigma above it, with P95 computed from L, M and S.
