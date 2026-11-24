# Releasing Keylight

Use `npm run package:dmg` and `npm run package:installer` to build and inspect desktop installers locally. See [INSTALLERS.md](INSTALLERS.md).

Keylight for Android is a separate paid app. Its project is not in this repository.

Run `npm run test:audio` in addition to the unit suite and engine self-test. It renders
the bundled recordings and expression controls offline in a hidden, muted process.
Keep physical MIDI, camera accuracy, and Windows installer execution
separate from synthetic test results in release notes. The `download-page` and `installers`
GitHub Actions workflows are manual and have not run merely because their files exist.

1. Set `version` in `package.json`. The bundle version and the zip name follow it.
2. Check the build:
   - `npm test` (blocksd watchdog, take downloads, the Windows build's zip and fuse code)
   - the engine self-test, which must end with `SELFTEST done` and no `FAIL` line:
     `npm run selftest` (it runs the app hidden in a throwaway profile and exits 0 or 1).
     CI runs it on macOS and on Windows, the latter from source and from the built
     `Keylight.exe`.
2b. Before packaging a RELEASE, build the bundled light service once: `scripts/build-blocksd.sh` (it needs
   Xcode command-line tools and `uv`). `scripts/package.sh` still builds without it, but that app would then
   light keys only when blocksd is installed by hand, so a release must not skip this step.
3. `scripts/package.sh --zip-only` writes `dist/Keylight-<version>-mac.zip`: a
   `Keylight-<version>` folder with `Keylight.app` and `README.txt` (the README's
   "Install" section). The script checks the signature again after a round
   trip through the zip. Plain `scripts/package.sh` also installs the build in
   `~/Applications` and refreshes the Desktop shortcuts.
   `npm run package:win` writes `dist/Keylight-<version>-win-x64.zip` (any system: it
   downloads Electron for Windows, checked against npm's `electron` checksums):
   `README.txt` (the README's "Install on Windows" section, as plain text) and a
   `Keylight` folder holding `Keylight.exe`, at the top of the zip, since Windows'
   Extract All makes the `Keylight-<version>-win-x64` folder itself. CI's `windows`
   job builds the same zip and keeps it for a week as the `keylight-win-x64` artifact.
4. Try the zip the way a tester gets it: download it with a browser (so macOS
   quarantines it), unzip, and follow `README.txt` on a Mac user account that has
   never run Keylight. On Windows, download the win zip with a browser, extract it and
   follow its `README.txt` (SmartScreen's **More info** > **Run anyway**), with the
   keyboard plugged in: the setup's Lights step should run a light across the keys.
5. Attach both zips to a GitHub release; a short clip from `scripts/record.sh` helps.
   The README's install steps send people to the Releases page, so the release with
   the Windows zip should be up before the "Install on Windows" section reaches `main`.

The build is ad-hoc signed and not notarised, hence the `xattr` step for testers. A
Developer ID signature plus notarisation would remove it. The bundle uses the
Electron architecture from `node_modules`. The release workflow builds for Apple
silicon. Build on an Intel Mac with x64 Node.js to get an Intel bundle.

The Windows exe is not code-signed either, so SmartScreen warns on first run (and
again after each new version) until it is signed with an Authenticode certificate.
