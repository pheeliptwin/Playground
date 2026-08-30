# Playground

A collection of small, polished, self-contained browser games. Each app lives in its
own folder and is fully client-side — no build step, no external dependencies, no backend.

## Apps

| App | Description |
| --- | --- |
| [Sky-Stack](sky-stack/) | Touch-first tower-stacking game. Time the drop of a moving platform to build the tallest tower possible. |

## Conventions

- One folder per app at the repo root (e.g. `sky-stack/`), containing at minimum an `index.html`.
- Apps are **self-contained**: all assets (CSS, JS, images) live in the app folder with no
  CDN or external-library dependencies.
- The root [`index.html`](index.html) is the app list / portal — add a card there when merging
  a new app so it shows up in the site's app list.
- The game loop runs on `requestAnimationFrame` with `dt`-based updates; the canvas scales
  via `devicePixelRatio` for crisp rendering on phones and large screens.

## Adding a new app

1. Create `my-app/index.html` (plus any local assets).
2. Run it locally: `python3 -m http.server 8000` then open `http://localhost:8000/my-app/`.
3. Add a card linking to it in the root `index.html` and a row in this README.

## Running

Serve the repo root with any static server, then open `/` for the app list:

```bash
python3 -m http.server 8000
```
