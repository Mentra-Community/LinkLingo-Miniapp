# Device run (emulator, real AnkiDroid)

`stage1.ts` drives the Mandarin app on an emulator through its own screens and checks the result in
AnkiDroid's own collection file. See `mandarin-app/docs/RUNBOOK.md` for the setup commands.

What it proves: pairing across both apps, a conversation arriving through the real LinkLingo backend, separate
speaker and correction decisions, a persisted draft, one note after a triple tap, a matching receipt, and the
hard case: server down while saving, app force-stopped, relaunch offline, reconnect, still one note and one receipt.

What it does not: LinkLingo's phone-side capture (needs the glasses microphone and MentraOS; unit tested only) and
typing Chinese (adb cannot), so the proposed correction is created through the API as analysis would.

Things that bit during development, so the next run does not lose time:

- Metro in `CI=1` mode does not watch files and silently serves stale code. Run it without `CI` (stdin from /dev/null).
- The emulator's default Metro address is `10.0.2.2:8081`; if another project's Metro owns 8081 the app loads the wrong
  bundle. Set the app's `debug_http_host` preference (the script does) and use another port.
- `uiautomator dump` waits for an idle UI. A screen that re-renders every second (the pairing-code countdown) or an
  overloaded host makes it fail with "could not get idle state" and a file-based dump then returns a STALE screen.
  The helpers stream the dump and retry; the pairing code is read from the HTTP response through `up.ts`'s proxy.
- A dev LogBox toast can cover the tab bar and swallow taps; dismiss it first. One toast ("Can't perform a React state
  update on a component that hasn't mounted yet") appears at startup and is worth tracing in a follow-up.
- AnkiDroid cold-starting from the content provider after being force-stopped crashed on this 2 GB emulator. Start
  AnkiDroid normally once and leave it running, and do not `am kill-all` the emulator.
- The AnkiDroid collection persists between runs, and the app correctly refuses a second card for a sentence it
  already has, so every run uses its own sentences.
- Do not `pkill -f scripts/device/up.ts` in the same command batch that starts a new one; stop it with SIGTERM and wait.
