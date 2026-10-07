# Verifying a release

Every tagged release publishes two assets: `team-tracker-X.Y.Z.html` (the
standalone build) and `checksums.txt`. The `Release` GitHub Actions workflow
also creates a [GitHub build-provenance
attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
for the HTML file and for every file in the PWA build (`dist/pwa/**`). That is
cryptographic proof (Sigstore-backed, not just a checksum) that a given file
was built by this repo's own workflow from that exact tagged commit, not
hand-assembled or modified after the fact. You can check it yourself instead
of taking it on faith.

## The standalone file

```
# 1. Download the release assets for the tag you want to verify (example: v1.5.1)
gh release download v1.5.1 -R fmpallini/team-tracker -p "*"

# 2. Confirm the HTML file matches the published checksum
sha256sum -c checksums.txt

# 3. Verify the build-provenance attestation (requires the GitHub CLI, gh).
#    Confirms the file's hash was attested by the "Attest build provenance"
#    step in this repo's release.yml, tying it to a specific workflow run and
#    source commit.
gh attestation verify team-tracker-1.5.1.html -R fmpallini/team-tracker
```

A successful verify exits with status `0`; a tampered or unrelated file fails
because there's no matching attestation for that file's hash. Adding
`--format json` also prints the source commit the file was built from, to
compare against the tag on the
[commits page](https://github.com/fmpallini/team-tracker/commits/main).

## The live web app

The PWA build isn't a separate release asset. It's attested directly and
deployed straight from that same attested build to GitHub Pages, so you can
verify what's actually live by downloading each served file and checking its
attestation:

```
for f in index.html sw.js manifest.json; do
  curl -s "https://fmpallini.github.io/team-tracker/$f" -o "live-$f"
  gh attestation verify "live-$f" -R fmpallini/team-tracker
done
```
