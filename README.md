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

## API defaults and accepted values

`strictWeaponClass` now uses one shared default across all filtering endpoints:

- Endpoints: `GET /api/search`, `POST /api/compatible`, `POST /api/explain`, `POST /api/solve`
- Default when omitted/missing: `true`
- Accepted values:
  - boolean: `true`, `false`
  - number: `1`, `0`
  - string: `"true"`, `"false"`, `"1"`, `"0"`
- Any other value falls back to the default (`true`).

When enabled (`true`), weapon candidates are restricted to the expected weapon type for the selected class (e.g. mage → wand).
When disabled (`false`), weapon type is not restricted by class (class requirements on items are still respected).
