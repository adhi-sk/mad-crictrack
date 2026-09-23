# MAD CricTrack 🏏

MAD CricTrack is a mobile-first cricket scoring Progressive Web App (PWA).

## What changed

The supplied application has been reorganized so it can be pushed directly to GitHub
and deployed as a static mobile web app with GitHub Pages.

### Repository structure

```text
cricket-scorer/
├── app/
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js
│   ├── css/
│   │   └── styles.css
│   ├── js/
│   │   └── app.js
│   └── icons/
│       ├── icon.svg
│       ├── icon-192.png
│       └── icon-512.png
├── backend/
│   ├── __init__.py
│   ├── engine.py
│   ├── models.py
│   ├── persistence.py
│   └── README.md
├── tests/
│   └── test_engine.py
├── .github/
│   └── workflows/
│       └── deploy-pages.yml
├── requirements-dev.txt
├── .gitignore
└── README.md
```

## Mobile app / GitHub Pages

The `app/` folder is the deployable PWA.

It uses:
- `manifest.json` for installable-app metadata.
- `sw.js` for offline caching of the app shell.
- `localStorage` for match state on the device.
- the browser Web Share API when available.
- browser print/PDF for the scorecard.

No server is required for normal scoring.

### Deploy

1. Create a new GitHub repository.
2. Extract this project and push the contents to the repository.
3. GitHub Actions will run `.github/workflows/deploy-pages.yml`.
4. In GitHub, open **Settings → Pages** and make sure the source is **GitHub Actions**.
5. Open the generated Pages URL on your iPhone/Android phone.
6. Use the browser's **Add to Home Screen / Install App** option.

### Local test of the PWA

From the repository root:

```bash
python -m http.server 8080 --directory app
```

Then open:

```text
http://localhost:8080
```

Do not open `index.html` directly with `file://`; service workers require HTTP(S).

## Python tests

Create a development environment and run:

```bash
python -m pip install -r requirements-dev.txt
pytest -q
```

The tests cover the supplied Python scoring engine's basic runs, extras, strike
rotation, over completion, and chase completion.

## Important architecture note

GitHub Pages serves static files. It cannot run the Python `backend/` code as a live
server. Therefore the mobile app uses the existing JavaScript scorer in `app/`.
The Python implementation is retained under `backend/` for automated tests, future
API work, or a later FastAPI deployment.

## Data

The current PWA stores match state in the browser's `localStorage`. Clearing browser
site data can remove an in-progress match. This version does not provide cloud
synchronization or multi-device shared scoring.

## Next possible upgrade

For a tournament environment, a future version can add a FastAPI backend plus a
database so multiple scorers/devices can share a live match, with authentication and
match history.
