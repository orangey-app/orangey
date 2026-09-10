# Publishing Orangey

The app lives at <https://orangey-app.github.io/orangey/>, built from the
repository `orangey-app/orangey`. Every push to `main` rebuilds and redeploys
it; there is nothing to configure for the address, because every path in
`dist/` is relative and the service worker registers with `scope: "."` — the
same build works at the root of a domain, on a project subpath, or from a
folder on disk.

The root of <https://orangey-app.github.io> is a separate, tiny repository
called `orangey-app.github.io`: a landing page listing the org's tools, with
no build step. Orangey sits on a subpath so that a second tool can join it
later without either having to move.

## First time

1. Create the repository `orangey` in the **orangey-app** organisation, public,
   with nothing pre-added — no README, no licence, no `.gitignore`.
2. In the folder that holds this repository:

   ```
   git remote add origin https://github.com/orangey-app/orangey.git
   git push -u origin main
   ```

3. On github.com, open the repository → **Settings → Pages → Build and
   deployment → Source: GitHub Actions**. There is no branch or folder to
   choose.
4. **Actions → Deploy to GitHub Pages → Run workflow.** If a run fired on the
   push before Pages was switched on, it will have failed; ignore it or re-run
   it. When the run is green the app is live.

`pages-build-deployment` is GitHub's own Jekyll pipeline and appears only while
Source is set to a branch. If you see it in the deployments list, the Source
setting has not taken: it will serve the README instead of the built app, and
overwrite whatever the workflow published.

## Afterwards

Commit, `git push`, wait for the Actions tab to go green, and the live site has
the change. A hard refresh (Ctrl+F5) skips the service worker's cached copy.

## The single file, three ways

`npm run build:single` writes `dist/orangey.html`, the whole app in one file
that works from a disk with no server. People can get it three ways, and
nothing needs doing for any of them:

- **From the site.** The Pages deploy runs `build:single`, so the live site
  serves it at <https://orangey-app.github.io/orangey/orangey.html>, and
  **Settings → About → Download** in the app fetches exactly that file. The
  fetch is relative, so it follows the app wherever it is served from.
- **From a release.** Push a tag like `v0.2.0` and `release.yml` builds,
  tests, and attaches `orangey.html` (and a ZIP of the static site) to a
  GitHub release with generated notes.
- **From the repository.** `dist/` is not committed — it is a build output
  and would add a 400 kB diff to every change — so a copy from the source
  means `npm run build:single`.

## Tagging a release

```
git tag v0.2.0
git push origin v0.2.0
```

## If the app ever moves again

Slide links carry the address, so a deck made today expects this URL for
years. GitHub Pages cannot redirect, so a move means leaving a stub
`index.html` at the old address that forwards, hash and all. Better not to
move: a second tool gets its own repository and its own subpath, and Orangey
stays where it is.
