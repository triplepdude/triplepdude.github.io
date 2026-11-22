GeoNames places for the Time Zone Converter (/time-zone-converter/)

Data: GeoNames geographical database, https://www.geonames.org/
Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),
         https://creativecommons.org/licenses/by/4.0/ (legal code in LICENSE.txt).
         GeoNames provides the data "as is" without warranty or any
         representation of accuracy, timeliness or completeness.
Files used (downloaded 22 November 2026 from https://download.geonames.org/export/dump/):
  cities15000.zip (every place with 15,000 people or more), admin1CodesASCII.txt
  (state and province names) and countryInfo.txt (country names).

Changes made: cities.txt keeps 2,827 of the places (all of 250,000 people or
more, every capital, the largest place of each of the 356 time zones used, and
the state or province capitals of countries that span more than one time zone),
and for each only its name, country, state or province and time zone, with
capitals marked. Rows are sorted by population. The script that makes the file
is tests/fixtures/time-zone-converter/build_cities.py.

Format: a comment line; "@z" then the time zone names, space-separated; "@c"
then "code name" for each country, separated by "|"; "@a" then "country.code
name" for each state or province; then one place per line as
name|country|state code|time zone index, with "|c" added for a capital.

The page loads this file the first time a place is searched for.
