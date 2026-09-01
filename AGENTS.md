# Project maintenance rules

- Preserve every existing plugin file when publishing a new plugin revision. Put the revision in the new filename, for example `theme-v2.js`, `theme-v3.js`.
- After every source change, run `npm test` and `git diff --check`.
- After rebuilding frontend code, change the cache-busting version on the viewer bundle URLs in `index.html` and browser test fixtures before UI verification.
- For UI behavior changes, verify the affected interaction in the real local viewer, preferably with the user's actual MinerU folder when one was provided.
- Prevent stale frontend assets after rebuilding. When the running local server code or cache behavior changed, read `mineru-layout-viewer-server.json` from the temp directory, verify its identity endpoint, and restart only the recorded MinerU Viewer PID. The preferred port is 18768 but the server may select another loopback port when it is occupied. Never stop the unrelated process occupying 18768. Tell the user to reopen the viewer from the shortcut.
- Do not modify the user's source MinerU folder during verification unless they explicitly request saving changes.
