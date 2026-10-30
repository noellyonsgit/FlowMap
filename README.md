# FlowMap

Point it at a local app. It finds the screens, traces the paths, photographs each route, and lets you save a PDF or send the board to Figma. With [Designer Preflight](https://github.com/noellyonsgit/designer-preflight) installed, it also checks every screen before you share it.

## Run it

You need [Node.js](https://nodejs.org/) 18 or newer, and [Google Chrome](https://www.google.com/chrome/).

```bash
npm install
npm start
```

Open http://127.0.0.1:3920

1. Choose the project folder and click **Map paths**. FlowMap starts that app’s dev server if it is not already running, then photographs each screen.
2. **Save as PDF** prints the board.
3. **Export to Figma** — in Figma, choose Plugins → Development → Import plugin from manifest…, pick `figma-plugin/manifest.json` from this project, and run **FlowMap Import** while this server is still running.

If Chrome is installed somewhere else, start FlowMap with `CHROME_PATH` set to that app.

## Check before you share

FlowMap works with [Designer Preflight](https://github.com/noellyonsgit/designer-preflight), a free pre-launch check for apps built with AI help. It looks for leaked keys, open databases, accessibility problems, iPhone and Android issues, and leftovers from earlier versions, and explains each one in plain language.

1. Install Designer Preflight (see its README). FlowMap finds it automatically.
2. Map a project, then click **Check**. Nothing in the project changes.
3. Problems appear as badges on each screen. Click one to see what is wrong, why it matters, and how to fix it.
4. Choose **Fix this** or **It’s fine as it is** on each problem.
5. Click **Take “before” pictures**, then **Fix what I approved**. An AI agent (Claude Code, Cursor or Codex, whichever is installed) fixes only what you approved, on a separate `preflight/` branch.
6. Click **Compare with before** to see exactly what changed on every screen, at phone, tablet and desktop sizes.

**Ask for a review** lets the agent read the code and add anything the automatic checks missed. It doesn’t change any project files, and FlowMap warns you if anything outside `.preflight/` changed.

For the Cursor agent, FlowMap uses the `cursor-agent` command if it is installed. To use the Cursor SDK instead, run `npm install @cursor/sdk` here and set `CURSOR_API_KEY`.

FlowMap also works the other way round: Designer Preflight can ask FlowMap for the list of screens (`preflight scan --routes-from flowmap`), using the `flowmap map <folder> --json` command.

## Visits

When the project has a git history or a changelog, each journey names the latest change. Connect Google to show how many visits reached each screen. The project needs a Google tag or Tag Manager snippet for that button to appear. Mapping and screenshots work without it.

The first time you connect:

1. Open the [Google Auth clients page](https://console.cloud.google.com/auth/clients). If it says the auth platform is not configured, click **Get started**.
2. Enable the **Google Analytics Data API** and the **Google Analytics Admin API**.
3. Create a client and choose **Desktop app**. Download the JSON. Allow this redirect: `http://127.0.0.1:3920/api/google/callback`
4. On **Audience**, add the Google account that can see Analytics as a test user.
5. In FlowMap, click **Connect Google** and choose that JSON. It is saved on this computer in `~/.flowmap/`, not in this repo.

While the Google app stays in Testing, connect again after 7 days.

You can set `FLOWMAP_GOOGLE_CLIENT_ID` and `FLOWMAP_GOOGLE_CLIENT_SECRET` instead of choosing the file. Do not commit either value.

If the [GitHub CLI](https://cli.github.com/) is installed and signed in, a production deploy can move the date of a change. Without it, FlowMap uses the changelog or the commit day.
