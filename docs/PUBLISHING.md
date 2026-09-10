# Publishing Orangey

The site lives at <https://orangey-app.github.io>, built from the repository
`orangey-app/orangey-app.github.io`. Every push to `main` rebuilds and
redeploys it; there is nothing to configure for the address, because every path
in `dist/` is relative.

## First time

1. Install [GitHub Desktop](https://desktop.github.com) and sign in.
2. Unzip the repository somewhere you will keep it, e.g. `Documents\orangey`.
3. **File → Add local repository**, choose that folder. The history is already
   there, so nothing is lost.
4. **Publish repository**. Set the name to `orangey-app.github.io` exactly,
   the owner to the **orangey-app** organisation, and leave "keep this code
   private" unticked.
5. On github.com, open the repository → **Settings → Pages → Build and
   deployment → Source: GitHub Actions**.
6. The **Actions** tab shows the deploy running. When it goes green, the site
   is live. The first build takes a couple of minutes; later ones are faster.

The name matters: a repository named `<org>.github.io` is served at the root
of `<org>.github.io`. Any other name would put the site under a subpath.

## Afterwards

Commit in GitHub Desktop, press **Push origin**, wait for the Actions tab to
go green, and the live site has the change. A hard refresh (Ctrl+F5) skips the
service worker's cached copy if you want to see it immediately.

## The single file, three ways

`npm run build:single` writes `dist/orangey.html`, the whole app in one file
that works from a disk with no server. People can get it three ways, and
nothing needs doing for any of them:

- **From the site.** The Pages deploy runs `build:single`, so the live site
  serves it at <https://orangey-app.github.io/orangey.html>, and
  **Settings → About → Download** in the app fetches exactly that file.
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

In GitHub Desktop: **Repository → Create tag…** on the commit, then push
with the tag. The Actions tab shows the release being built.
