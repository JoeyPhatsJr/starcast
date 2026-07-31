# 🔭 Starcast

**Is it good to stargaze at my location right now?**

Starcast is a single-page stargazing-conditions dashboard inspired by the iOS app
*Good To Stargaze* (not affiliated). It blends the hourly weather forecast, on-device
sun/moon/planet ephemeris math, and your local light-pollution level into a single
color-coded verdict — plus a 3×4 grid of condition tiles, a scrubbable 24-hour
timeline, day tabs for the full 14-day forecast, and 72-hour charts.

![Screenshot](docs/screenshot.png)

## Features

- **Verdict banner** — "Good To Stargaze" / "Marginal Stargazing" / "Not Good To
  Stargaze" for the exact hour you scrub to, with a LIVE ribbon on the current hour.
- **12 condition tiles**, each independently color-coded green/olive/red: weather,
  sun times, visibility, wind chill, wind, precipitation probability, cloud cover,
  seeing, transparency, moon phase (with a real phase graphic), visible planets,
  and your Bortle light-pollution class.
- **24-hour scrubbable timeline** colored hour-by-hour by overall score, with
  daylight hours dimmed, plus day tabs across the whole forecast range.
- **Forecast grid** — a Clear Outside-style hour-by-hour table for the next
  7 days: cloud layers, precipitation, wind, temperature/dew point, humidity,
  seeing, transparency, and moon-up per hour, every cell color-coded, with sun
  and moon rise/set times and the astronomical-darkness window per day.
- **Automatic light pollution** — your Bortle class is measured on the fly
  from David Lorenz's World Atlas 2024 zenith-brightness tiles for your exact
  coordinates (manual override always available).
- **Interactive charts** — cloud (total + high), temperature + dew point,
  wind, and seeing/transparency over 24 h / 3 d / 7 d, with touch/hover value
  tooltips, daylight shading, and a "now" marker.
- **All astronomy computed client-side**: solar and lunar altitude, moon
  illumination and phase direction, and planet visibility from Keplerian orbital
  elements. No astronomy libraries, no API keys, no server.

## Data sources

- **[Open-Meteo](https://open-meteo.com)** — hourly weather forecast, sunrise/sunset,
  and city geocoding. Free for non-commercial use, no API key, CORS-enabled.
- **[7Timer!](https://www.7timer.info)** — astronomical seeing and transparency from
  the ASTRO product (~72 h coverage). When it's unreachable or out of range, Starcast
  falls back to a clearly-marked heuristic estimate.
- **[David Lorenz's Light Pollution Atlas 2024](https://djlorenz.github.io/astronomy/lp/)**
  — zenith sky brightness decoded client-side from his public binary tiles and
  converted to an approximate Bortle class.

All displayed times use the forecast location's timezone (as reported by
Open-Meteo), never your browser's.

## Run locally

No build step, no dependencies:

```bash
python3 -m http.server
```

Then open <http://localhost:8000>. (Any static file server works — this is exactly
how GitHub Pages serves it.)

## Deploy to GitHub Pages

1. Create a new repository on GitHub (e.g. `starcast`).
2. Push this folder to it:

   ```bash
   git init
   git add .
   git commit -m "Starcast"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/starcast.git
   git push -u origin main
   ```

3. On GitHub, open the repo → **Settings** → **Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
5. Choose branch **main** and folder **/ (root)**, then click **Save**.
6. Wait a minute, then visit `https://YOUR_USERNAME.github.io/starcast/`.

The repo includes a `.nojekyll` file so GitHub Pages serves every file as-is, and
all asset paths are relative, so the app works from a project subpath out of the box.

## Project structure

```
index.html       app shell + all four views
.nojekyll        tells GitHub Pages to skip Jekyll processing
css/style.css    the whole design system
js/app.js        entry point: state, boot, routing, event wiring
js/weather.js    Open-Meteo + 7Timer fetch/parse
js/lightpollution.js  Lorenz atlas tile decoding → Bortle estimate
js/astro.js      sun / moon / planet ephemeris + rise/set solver (Meeus-style, ±1°)
js/score.js      per-metric scoring + weighted overall verdict
js/ui.js         all DOM rendering (tiles, timeline, charts, SVG icons)
```
