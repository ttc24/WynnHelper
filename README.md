# WynnHelper
A helper for building setups in Wynncraft

## Run locally
After downloading run:
- `npm install` (only required the first time)
- `npm run start`

## Styling resilience / offline behavior
- The app now loads a vendored Pico-compatible stylesheet from `public/vendor/pico.min.css` by default.
- This keeps the UI readable/styled even when the CDN is blocked or you're fully offline.
- `public/index.html` includes a commented CDN `<link>` example if you want to opt back into network-hosted Pico updates.
