# Recovered copy

The original repository lived on the `satiricalguru` GitHub account, which was suspended, and the local folder had been deleted.
This copy was rebuilt on 2026-11-20 from Claude Code and Antigravity session history: the last known contents of every file written, edited or read in those sessions, merged in time order (39 files).

**What may be missing:** files never opened in a session (lockfiles, generated code, images, audio, models) and the git history. A few files had a later edit that could not be re-applied, so they may be slightly behind; see the list below.

## Possibly stale or missing files
```
Files edited but never seen whole (missing):
Synthid-remover/.gitignore
Synthid-remover/app/components/Navbar.tsx

Files with an edit that did not apply (may be stale):
Synthid-remover/.github/workflows/deploy.yml
Synthid-remover/README.md
Synthid-remover/app/api/inpaint/route.ts
Synthid-remover/app/components/HeroImageScanner.tsx
Synthid-remover/app/components/InpaintCanvas.tsx
Synthid-remover/app/dashboard/page.tsx
Synthid-remover/app/page.tsx
Synthid-remover/lib/clientImageProcessor.ts
Synthid-remover/lib/imageProcessor.ts
Synthid-remover/lib/localHistory.ts
Synthid-remover/package.json
Synthid-remover/scripts/capture-visuals.mjs
Synthid-remover/scripts/inspect-verify.mjs
Synthid-remover/scripts/probe-corrupt.mjs
Synthid-remover/scripts/probe-metadata.mjs
Synthid-remover/scripts/probe-provenance.mjs
Synthid-remover/scripts/probe-tiny.mjs
Synthid-remover/scripts/test-edge-cases.mjs
Synthid-remover/scripts/test-upload.mjs
Synthid-remover/scripts/verify-pipeline.mjs
```

## Audit (2026-11-20)

- `npm run lint` and `npm test` pass. The test skips the real-photo fixture because `public/hero-watermarked.jpg` was lost; add any watermarked photo there to run it.
- `npm run build` fails until these UI files are restored: `app/components/ImageDropzone`, `app/components/ProcessingLogs`, `app/components/Navbar`, `app/components/ThemeProvider`, `app/globals.css`, and the `public/` folder.
