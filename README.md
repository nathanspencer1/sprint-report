# Jira Sprint Report Web App

A minimal Node.js + Express web app with a static frontend to log in to Jira, list boards, fetch the 26 most recent sprints for a board, and display a sprint report.

## Features
- Login with Jira domain, email, and API token (validated against `/rest/api/3/myself`).
- List all accessible Jira boards (Agile boards).
- Show the 26 most recent sprints for a selected board.
- Sprint report for a selected sprint:
  - Issues grouped by status
  - Story points totals (auto-detects Story Points custom field)
  - Quick summary: total issues, total SP, done SP
  - Issue keys hyperlink to Jira
- Logout to clear the session.

## Project structure
- `server/index.js` — Express server, session handling, Jira API proxy endpoints
- `public/index.html` — Single-page UI (login, board selection, sprint selection, report view)
- `package.json` — App scripts and dependencies
- `.gitignore` — Node ignores

## Prerequisites
- Node.js 16+ installed
- A Jira Cloud account with API access and an API token
  - Generate token: https://id.atlassian.com/manage-profile/security/api-tokens
  - Jira Site input accepts: `your-domain`, `your-domain.atlassian.net`, or `https://your-domain.atlassian.net`

## Install and run (Windows PowerShell)
From the project root:

```powershell
cd c:\Git\GitHub\nathan-spencer\sprint-report
npm install
$env:PORT=3000; $env:SESSION_SECRET="dev-secret"; npm start
```

- App will start at: http://localhost:3000 (you may also see alternate ports used during development like 3001/3002)
- For development with auto-restart: `npm run dev`

## Deployment

### Option 1: Render (free tier)
This repo includes `render.yaml` for one‑click deploy.

1. Push your code to GitHub.
2. In Render, create a new Web Service from your repo and let it detect `render.yaml`.
3. It will build from the Dockerfile and start on port 3000.
4. Set environment variable `SESSION_SECRET` (Render will auto-generate if you keep generateValue: true).
5. Health check path: `/healthz`.

### Option 2: Docker

Build and run locally:

```powershell
docker build -t sprint-report .
docker run -p 3000:3000 -e SESSION_SECRET="prod-secret" --name sprint-report sprint-report
```

Then open http://localhost:3000.

### Option 3: Azure App Service (container)

Push the built image to a registry (e.g., ACR or Docker Hub), then create an App Service for Containers pointing at the image, with `PORT=3000` and `SESSION_SECRET` configured.

## Usage
1. Open http://localhost:3000
2. Enter:
  - Jira Site: enter `your-domain`, `your-domain.atlassian.net`, or the full URL
   - Email: your Jira account email
   - API Token: a valid Jira API token
3. Click "Login".
4. Select a board and click "Load Recent Sprints".
5. Select a sprint and click "Load Sprint Report".
6. View totals and issues grouped by status; click an issue key to open it in Jira.
7. Use the "Logout" button to clear the session.

## Endpoints
Backend (proxied through same origin):
- `POST /api/login` — body `{ domain, email, apiToken }`; validates credentials and stores in session
- `GET /api/me` — returns minimal session info (`baseUrl`, `host`, `email`, `displayName`)
- `GET /api/boards` — returns boards accessible by the user
- `GET /api/boards/:boardId/sprints` — paginates and returns the 26 most recent sprints (active/closed/future)
- `GET /api/sprints/:sprintId/report` — returns a pragmatic sprint report payload
- `POST /api/logout` — clears session
- `GET /healthz` — simple health check for uptime monitoring

## Notes and limitations
- Story points field:
  - Tries `customfield_10016` by default, then auto-detects by name matching `/story\s*points/i`.
  - If your instance uses a different field name, detection should pick it up; otherwise, adjust in `server/index.js`.
- "Done" points are computed using status name "Done". If your team uses another terminal state (e.g., "Closed"), tweak the logic in the frontend or backend.
- Jira Agile APIs must be enabled, and your account must have access to the boards and sprints you want to view.
- This app stores Jira credentials in an in-memory session for this server instance. For production:
  - Use HTTPS and secure cookies
  - Switch to a proper session store (Redis, database)
  - Avoid storing raw tokens long-term; consider short-lived tokens or OAuth 2.0 (3LO) if suitable

## Troubleshooting
- 401 Unauthorized on login:
  - Verify domain is only the subdomain (`your-domain`), not the full URL
  - Confirm your email and API token are correct
  - Ensure your account has permission to access Jira REST APIs
- No boards returned:
  - Confirm you have at least one Agile board and access to it
  - Some boards may be team-managed vs. company-managed; both are supported via the Agile API
- Story points show as 0 or missing:
  - Your project may use a different SP custom field; ensure Story Points is present on the issue screens and that values are set
- "Done" SP is 0 but issues are completed:
  - Your done status may not be named "Done"; update the calculation accordingly

## Development tips
- Environment variables (PowerShell) can be set inline per command by joining with `;`:

```powershell
$env:PORT=3000; $env:SESSION_SECRET="dev-secret"; npm start
```

- To change port, set `PORT` accordingly.
- Update the UI in `public/index.html`; the backend is already set to serve static files from `public/`.

## Roadmap (nice-to-haves)
- Classic sprint report metrics (commitment vs. completed, scope change timeline)
- Filters (assignee, label, issue type)
- Export to CSV/PDF
- Persisted auth flows (OAuth), secure secret storage
- Tests and CI
