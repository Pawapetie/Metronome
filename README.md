# Metronome

A practical, phone-first metronome web app. Plain HTML/CSS/JS — no build step.

## Features
- Type-to-set BPM (20–300), scroll wheel for fine changes, −/+ buttons, tap tempo
- Time signatures that follow music theory (top 1–16, bottom 1/2/4/8/16/32), compound-meter grouping
- Per-beat accents (accent / normal / mute) and a "stress first beat" toggle
- Subdivisions (8ths, triplets, 16ths, quintuplets, sextuplets)
- Synthesized sound kits, volume control
- Saved presets, remembers last settings
- Dark mode (default), light mode, installable PWA, works offline, keeps screen awake

## Run locally
```
npx serve .
# or
python -m http.server 8000
```
Then open http://localhost:8000 (or the port shown).

## Deploy
Connect this repo to Netlify (publish directory `.`, no build command). Every push to `main` deploys.
