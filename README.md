# Skyster

**Play: https://kennyhassmusic.github.io/skyster/**

An unofficial fan game: drive, wall-ride and fly a Tesla Roadster through real downtown Chicago with
Rocket League controls. Runs in the browser (Chrome, Edge or Safari; an Xbox controller is best).

- 17,588 buildings with lidar-measured heights, the real street grid, signals and the L
- Rocket League car physics scaled to the Roadster: jumps, flips, air roll, wall riding, boost
- Flight mode (hold LB in the air) and three fuel add-ons to find around the city
- Traffic of Teslas, people and Optimus on the sidewalks
- Chase, cockpit and bumper cameras

## Credits

Map data © OpenStreetMap contributors (ODbL) and the Overture Maps Foundation; building heights from
USGS 3DEP lidar. Built with three.js. Not affiliated with or endorsed by Tesla, Inc.

## Working on it

Plain static files, no build step: serve the folder (`python3 -m http.server`) and open it.
`python3 tools/bump.py <build>` stamps the cache-busting version on every module;
`tools/ship.sh "message"` commits and pushes, which updates the live site.
