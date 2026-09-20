# Release

**Do not run anything in this file until Jarred says so.** The repository is
staged locally on purpose. Nothing has been pushed, published or registered.
Trademark clearance for the name comes first.

## 0. The rule that shapes everything below

**This working repository never gets a public remote, and there is no
`--push` from it. Ever.**

Its history carries real business names in seven blobs: `docs/study/study-1.json`
(128 names), `docs/hero.svg`, two versions of `README.md`, `test/scan.test.mjs`,
`src/node/convert-grid-scan.mjs` and `PLAN.md`. The working tree is clean of
them, and it is clean of the Google feature ids too, but the history is not and
cannot be made so while the private branches stay here.

An orphan commit in this repository does not fix that. It leaves the named
history in the same `.git`, so any later `git push --all`, `git push --mirror`,
a GUI "publish branch", or a plain `git push origin master` sends it. And the
verification it suggests, `git log --all --oneline -S"<name>"`, can never print
nothing here, because `--all` includes the branch the names are on.

So the public repository is built **in a separate directory** by the
orchestrator, from an archive of the tree, and committed once under a noreply
identity. The named history and the public remote never share a `.git`.

```sh
# 1. Export the tree, with no history at all.
mkdir -p ../falloff-public
git archive HEAD | tar -x -C ../falloff-public
cd ../falloff-public

# 2. One commit, with the identity in the command rather than in a config
#    that happens to be set. Replace <id> with the GitHub user id number.
git init -b main
git add -A
git -c user.name="Jarred O'Brien" \
    -c user.email="<id>+CandyFlex@users.noreply.github.com" \
    commit -m "falloff 0.1.0"

# 3. Now verify, inside this directory, where --all means what it says.
git log --format='%an <%ae>' --all | sort -u      # exactly one identity, the noreply one
git log --oneline --all                           # exactly one commit
git log --all --oneline -S"<a business name you know is in the studies>"   # must print nothing
git log --all --oneline -S"0x8857"                # must print nothing: no Google feature id
```

Only then create the remote, from that directory:

```sh
gh repo create CandyFlex/falloff --public --source . --push
```

`--source .` is safe here and only here, because this directory has one commit
and no other branch. Running it in the working repository publishes everything.

## 1. Before that export, check these

These are blockers, not suggestions. Each has the command that checks it.

1. **Everything green.**

   ```sh
   npm test
   npm run check-docs-sync
   npm run check-docs-data
   node scripts/studies-index.mjs --check
   npm pack --dry-run          # only src/, bin/, README.md, LICENSE, package.json
   grep -rn -e $'\xe2\x80\x94' -e $'\xe2\x80\x93' README.md SKILL.md docs/*.html docs/*.css bin src/*.mjs    # em and en dashes (UTF-8 bytes); must print nothing
   ```

2. **No salt and no private study is tracked.** `test/leak.test.mjs` asserts
   this, structurally, so it runs in CI and in a fresh clone. Confirm by hand
   once more before the export:

   ```sh
   git ls-files | grep -E '\.salt$|^studies/private/'    # must print nothing
   ```

3. **Names.** `falloff` was free on npm on 2026-09-19. `falloff.io` and
   `falloff.dev` were unregistered on 2026-09-18. Check all three again on the
   day; none of them is held.

Then set the repository description and topics to match `package.json`.

## 2. GitHub Pages

Repository settings, Pages:

- Source: deploy from a branch
- Branch: `main`, folder: `/docs`
- Enforce HTTPS: on

`docs/lib/` is a generated copy of the browser-safe part of `src/`. CI fails
if it drifts. The page makes no external requests, so there is nothing else
to configure.

Custom domain (optional, after registering one):

- Add the domain in the Pages settings, which writes `docs/CNAME`.
- DNS: a `CNAME` record from `www` to `candyflex.github.io`, and for the apex
  the four GitHub Pages `A` records listed in GitHub's Pages documentation.
- Wait for the certificate, then turn on Enforce HTTPS.

## 3. npm

Needs Jarred's npm login. It cannot be done from an agent session.

```sh
npm login
npm pack --dry-run      # read the file list one more time
npm publish --access public
```

Publish from `../falloff-public`, not from the working repository, so that the
tarball is built from exactly the tree that went public.

Then tag the release, in that same directory:

```sh
git tag v0.1.0
git push origin v0.1.0
```

and change the `0.1.0 (unreleased, staged 2026-09-19)` heading in
`CHANGELOG.md` to the release date. The README says "Not on npm yet. Clone
it"; change that to the install command on the same day, and not before.

## 4. After release

- Open the published Pages URL at 360, 768 and 1280 px, light and dark, and
  confirm zero console errors and zero requests to any other origin.
- Run `npx falloff help` in an empty directory to confirm the published
  package starts.
