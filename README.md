# FlowMap

**Built by [MoreThought](https://morethought.co).**

Point it at a local app. FlowMap reads the routes, builds the journeys people take, photographs each screen (including multi-step forms, overlays, and signed-in paths when you ask), lays visits on the path when Analytics is connected, scores how easy each path looks structurally, and lets you save a PDF or send the board to Figma. With [Designer Preflight](https://github.com/noellyonsgit/designer-preflight) installed, it also checks every screen before you share the app.

## Run it

You need [Node.js](https://nodejs.org/) 18 or newer, and [Google Chrome](https://www.google.com/chrome/).

```bash
npm install
npm start
```

Open http://127.0.0.1:3920

1. **Choose folder**, optionally set the app URL if it’s already running, and optionally add a login email/password so FlowMap can photograph the signed-in product.
2. Click **Map paths**. FlowMap starts that app’s dev server if needed, walks the journeys, and captures screenshots.
3. Switch **Paths** on the board to move between journeys. Zoom with the controls or the trackpad; click a screen to enlarge it.
4. **Save as PDF** prints the board. **Export to Figma** places one frame per step (see below). **Open site** jumps to the running local app when FlowMap knows its URL.

If Chrome is installed somewhere else, start FlowMap with `CHROME_PATH` set to that app. To change the port, set `FLOWMAP_PORT` (default `3920`).

### Export to Figma

1. Keep FlowMap running.
2. In Figma: Plugins → Development → Import plugin from manifest…
3. Choose `figma-plugin/manifest.json` in this project.
4. Run **FlowMap Import**. It places one frame per step, with the screenshot.

## What mapping covers

FlowMap does more than a flat route list:

- **Journeys (Paths)** — product flows assembled from the home screen and linked routes, not one endless crawl.
- **Happy path, “When it goes wrong”, and Other screens** — main steps, error/empty/validation states where they can be found, and screens nothing links to.
- **Multi-step forms** — wizards and staged signup/onboarding are captured step by step when the code exposes those stages.
- **Overlays on the same URL** — dialogs, sheets, and preview/order-style panels discovered from common UI patterns, photographed when FlowMap can open them.
- **Signed-in journeys** — optional credentials in the Choose folder dialog (or env vars below) so capture can log in and map the product behind auth.
- **Ease of use** — each journey gets a structural score (“Easy / OK / Hard to use”) based on path length, forms, and recovery — not a claim about how the product *feels*.

## Visits

When the project has git history or a changelog, each journey can name the latest change. Connect Google to show how many visits reached each screen, filter by device (computers / phones / tablets) and traffic source (search, ads, social, email, and so on), and switch accounts when you need a different Analytics property.

The project needs a Google tag or Tag Manager snippet for the Connect Google control to appear. Mapping and screenshots work without it.

### Connect Google (first time)

1. Open the [Google Auth clients page](https://console.cloud.google.com/auth/clients). If it says the auth platform is not configured, click **Get started**.
2. Enable the **Google Analytics Data API** and the **Google Analytics Admin API**.
3. Create a client and choose **Desktop app**. Download the JSON. Allow this redirect: `http://127.0.0.1:3920/api/google/callback`
4. On **Audience**, add the Google account that can see Analytics as a test user.
5. In FlowMap, click **Connect Google** and choose that JSON. It is saved on this computer in `~/.flowmap/`, not in this repo. If several sites are available, use **Choose site** (the status line can prompt you).

While the Google app stays in Testing, connect again after 7 days.

You can set `FLOWMAP_GOOGLE_CLIENT_ID` and `FLOWMAP_GOOGLE_CLIENT_SECRET` instead of choosing the file. Do not commit either value.

If the [GitHub CLI](https://cli.github.com/) is installed and signed in, a production deploy can move the date of a change. Without it, FlowMap uses the changelog or the commit day.

## Check before you share

FlowMap works with [Designer Preflight](https://github.com/noellyonsgit/designer-preflight), a free pre-launch check for apps built with AI help. It looks for leaked keys, open databases, accessibility problems, iPhone and Android issues, and leftovers from earlier versions, and explains each one in plain language.

1. Install Designer Preflight (see its README). FlowMap finds it automatically (`PREFLIGHT_DIR` / `PREFLIGHT_BIN` if it’s somewhere unusual).
2. Map a project, then click **Check**. Nothing in the project changes.
3. Problems appear as badges on each screen. Click one to see what is wrong, why it matters, and how to fix it.
4. Choose **Fix this** or **It’s fine as it is** on each problem.
5. Click **Take “before” pictures**, then **Fix what I approved**. An AI agent (Claude Code, Cursor, or Codex — whichever is installed) fixes only what you approved, on a separate `preflight/` branch.
6. Click **Compare with before** to see exactly what changed on every screen, at phone, tablet, and desktop sizes.

**Ask for a review** lets the agent read the code and add anything the automatic checks missed. It doesn’t change project files on purpose, and FlowMap warns you if anything outside `.preflight/` changed.

For the Cursor agent, FlowMap uses the `cursor-agent` command if it is installed. To use the Cursor SDK instead, run `npm install @cursor/sdk` here and set `CURSOR_API_KEY` (optional `FLOWMAP_CURSOR_MODEL`).

FlowMap also works the other way round: Designer Preflight can ask FlowMap for the screen list (`preflight scan --routes-from flowmap`) via the CLI below.

## Command line

```bash
npx flowmap map <folder> [--json]
npx flowmap capture <folder> [--url http://localhost:3000] [--viewport iphone|android|tablet|desktop] [--out <folder>] [--json]
```

- **map** — lists screens, journeys, “When it goes wrong” states, and orphan screens (JSON for tools).
- **capture** — starts the app (or uses `--url`), screenshots every screen, writes PNGs under `<folder>/.flowmap/shots/` by default.

## Optional environment

Copy the names you need into a local `.env` or your shell. Never commit real secrets.

| Variable | Purpose |
| --- | --- |
| `FLOWMAP_PORT` | Server port (default `3920`) |
| `CHROME_PATH` | Path to Chrome if it isn’t in the usual place |
| `FLOWMAP_LOGIN_EMAIL` / `FLOWMAP_LOGIN_PASSWORD` | Default signed-in capture (UI overrides these) |
| `FLOWMAP_GOOGLE_CLIENT_ID` / `FLOWMAP_GOOGLE_CLIENT_SECRET` | Analytics OAuth without picking a JSON file |
| `PREFLIGHT_DIR` / `PREFLIGHT_BIN` | Where Designer Preflight lives |
| `CURSOR_API_KEY` / `FLOWMAP_CURSOR_MODEL` | Cursor SDK agent (optional) |

Project-specific login fallbacks also exist (`FLOWMAP_FAMILYTREE_*`, `FLOWMAP_PLANE_*`, `FLOWMAP_GHOST_*`) for apps you map often.
