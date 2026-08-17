# atlas

map your feelings to a song.

## structure

```
├── index.html          ← frontend (GitHub Pages)
├── probe.js            ← chat panel
├── atlas-data.js       ← song data
├── pipeline.html       ← data pipeline dashboard
├── server/             ← backend (Render)
│   ├── src/server.ts   ← probe server (Groq API)
│   ├── start.sh
│   ├── package.json
│   └── data/plates.py  ← 37 emotional territories
└── design-examples/
```

## run locally

```bash
# backend
cd server && bun install && ./start.sh

# open index.html in browser
```

## deploy

- **frontend:** GitHub Pages (serves from root)
- **backend:** Render (deploys from `server/`)
