# FlowMap

Point it at a local app. It finds the screens, traces the paths, photographs each route, and lets you save a PDF or send the board to Figma.

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
