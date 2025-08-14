const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

function ensureAuth(req, res, next) {
  if (req.session && req.session.jira) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function jiraHeaders(email, apiToken) {
  const token = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function normalizeBaseUrl(input) {
  if (!input) return '';
  let s = String(input).trim();
  const lower = s.toLowerCase();
  // Fix common missing colon typos like 'https//foo' or 'http//foo'
  if (lower.startsWith('https//')) s = 'https://' + s.slice('https//'.length);
  if (lower.startsWith('http//')) s = 'http://' + s.slice('http//'.length);
  // Trim trailing slashes
  s = s.replace(/\/+$/, '');
  // If already has protocol, return as-is
  if (/^https?:\/\//i.test(s)) return s;
  // If appears to be a full host (has a dot)
  if (s.includes('.')) {
    // If it's already an atlassian host, don't append again
    if (/atlassian\.net$/i.test(s)) return `https://${s}`;
    return `https://${s}`;
  }
  // Treat as cloud subdomain only
  return `https://${s}.atlassian.net`;
}

// Login: store domain/email/token in session after verifying
app.post('/api/login', async (req, res) => {
  const { domain, email, apiToken } = req.body;
  if (!domain || !email || !apiToken) {
    return res.status(400).json({ error: 'domain, email, and apiToken are required' });
  }
  try {
    const baseUrl = normalizeBaseUrl(domain);
    // Validate credentials by calling /myself
    const r = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: jiraHeaders(email, apiToken),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(401).json({ error: 'Invalid Jira credentials', details: text });
    }
    const user = await r.json();
    const urlObj = new URL(baseUrl);
    const host = urlObj.host;
    req.session.jira = { baseUrl, host, email, apiToken, accountId: user.accountId, displayName: user.displayName };
    res.json({ ok: true, user: { accountId: user.accountId, displayName: user.displayName }, baseUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed', details: String(err) });
  }
});

// Current session info (minimal)
app.get('/api/me', ensureAuth, (req, res) => {
  const { jira } = req.session;
  res.json({ baseUrl: jira.baseUrl, host: jira.host, email: jira.email, displayName: jira.displayName });
});

// Logout
app.post('/api/logout', ensureAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Failed to logout' });
    res.json({ ok: true });
  });
});

// List all boards available to user
app.get('/api/boards', ensureAuth, async (req, res) => {
  const { baseUrl, email, apiToken } = req.session.jira;
  const boards = [];
  let startAt = 0;
  try {
    while (true) {
      const r = await fetch(`${baseUrl}/rest/agile/1.0/board?startAt=${startAt}&maxResults=50`, {
        headers: jiraHeaders(email, apiToken),
      });
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch boards' });
      const data = await r.json();
      boards.push(...(data.values || []));
      if (data.isLast || startAt + data.maxResults >= data.total) break;
      if (!data.values || data.values.length === 0) break;
      startAt += data.maxResults || data.values.length;
      if (startAt > 1000) break; // safety
    }
  boards.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ boards });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching boards', details: String(err) });
  }
});

// Get 10 most recent sprints for a board
app.get('/api/boards/:boardId/sprints', ensureAuth, async (req, res) => {
  const { boardId } = req.params;
  const { baseUrl, email, apiToken } = req.session.jira;
  try {
    // Jira sprints endpoint supports pagination. Fetch all (or until safety cap), then pick latest 26.
    const all = [];
    let startAt = 0;
    const maxResults = 50;
    for (let page = 0; page < 200; page++) { // hard safety cap
      const url = `${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,closed,future&startAt=${startAt}&maxResults=${maxResults}`;
      const r = await fetch(url, { headers: jiraHeaders(email, apiToken) });
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch sprints' });
      const data = await r.json();
      const values = data.values || [];
      all.push(...values);
      const fetched = values.length;
      const step = data.maxResults || fetched || maxResults;
      const total = typeof data.total === 'number' ? data.total : null;
      const isLast = data.isLast === true || fetched === 0 || (total != null && startAt + step >= total);
      if (isLast) break;
      startAt += step;
    }

    const dateFor = s => {
      const d = s.startDate || s.completeDate || s.createdDate || 0;
      const t = Date.parse(d);
      // Fallback to numeric id if date parse fails
      return Number.isFinite(t) ? t : (typeof s.id === 'number' ? s.id : parseInt(s.id, 10) || 0);
    };
    const latest = all
      .sort((a, b) => dateFor(b) - dateFor(a))
      .slice(0, 26);
    // Now sort the selected latest 26 alphabetically descending by name
    const sprints = latest.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    res.json({ sprints, totalFetched: all.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching sprints', details: String(err) });
  }
});

// Sprint report
// There is no single official "sprint report" API in v1 agile; the classic sprint report uses issue search + sprint scope changes.
// We'll provide a pragmatic report: issues in sprint (by sprint id), grouped by status, with story points, and summary stats.
app.get('/api/sprints/:sprintId/report', ensureAuth, async (req, res) => {
  const { sprintId } = req.params;
  const { baseUrl, email, apiToken } = req.session.jira;
  try {
    // First, fetch sprint details to derive originBoardId (rapidViewId for sprint report)
    let originBoardId = null;
    try {
      const sR = await fetch(`${baseUrl}/rest/agile/1.0/sprint/${sprintId}`, { headers: jiraHeaders(email, apiToken) });
      if (sR.ok) {
        const sData = await sR.json();
        originBoardId = sData.originBoardId || sData.rapidViewId || null;
      }
    } catch {}

    let rows = [];
    let meta = {};
    let totals = {};

    if (originBoardId) {
      // Use Greenhopper sprint report (used by Jira UI) to get action buckets and "added" flags
      const ghUrl = `${baseUrl}/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${originBoardId}&sprintId=${sprintId}`;
      const gh = await fetch(ghUrl, { headers: jiraHeaders(email, apiToken) });
      if (gh.ok) {
        const rep = await gh.json();
        const contents = rep?.contents || {};
        const addedRaw = contents.issueKeysAddedDuringSprint;
        const addedKeys = Array.isArray(addedRaw)
          ? addedRaw
          : (addedRaw && typeof addedRaw === 'object')
            ? Object.keys(addedRaw)
            : [];
        const addedSet = new Set(addedKeys);
        const spField = rep?.sprintState?.linkedPages?.estimateStatisticFieldId || contents?.estimateFieldId || 'customfield_10016';
        meta.storyPointField = spField;

  const toNum = (v) => (typeof v === 'number' ? v : (v != null ? Number(v) : null));
  const getInitialSP = (issue) => toNum(issue?.estimateStatistic?.statFieldValue?.value);
  const getFinalSP = (issue) => toNum(issue?.currentEstimateStatistic?.statFieldValue?.value);

        const mapIssue = (issue, action) => {
          const initial = getInitialSP(issue);
          const final = getFinalSP(issue);
          const change = (initial != null && final != null) ? Math.abs(final - initial) : null;
          return {
          Action: action,
          Key: issue.key,
          Added: addedSet.has(issue.key) ? '*' : '',
          Summary: issue.summary,
          IssueType: issue.typeName,
          Priority: issue.priorityName,
          Status: issue.statusName,
          Assignee: issue.assigneeDisplayName || issue.assigneeName || issue.assignee || '',
          PointsInitial: initial,
          PointsFinal: final,
          PointsChange: change,
        };
        };

        const completed = (contents.completedIssues || []).map(i => mapIssue(i, 'Completed'));
        const notCompleted = (contents.issuesNotCompletedInCurrentSprint || []).map(i => mapIssue(i, 'NotCompleted'));
        const removed = (contents.puntedIssues || []).map(i => mapIssue(i, 'Removed'));
        // Combine; keep order: Completed, NotCompleted, Removed (can be adjusted)
        rows = [...completed, ...notCompleted, ...removed];

        totals = {
          completed: completed.length,
          notCompleted: notCompleted.length,
          removed: removed.length,
        };
      }
    }

    if (rows.length === 0) {
      // Fallback: build from JQL with best-effort mapping (no per-issue added/initial/change)
      const jql = encodeURIComponent(`sprint = ${sprintId} ORDER BY status, priority, key`);
      const searchUrl = `${baseUrl}/rest/api/3/search?jql=${jql}&maxResults=200&fields=summary,status,assignee,issuetype,priority,customfield_10016`;
      const r = await fetch(searchUrl, { headers: jiraHeaders(email, apiToken) });
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch sprint issues' });
      const data = await r.json();
      // Detect SP field
      let storyPointField = 'customfield_10016';
      const hasAnySP = (data.issues || []).some(i => i.fields && Object.prototype.hasOwnProperty.call(i.fields, 'customfield_10016'));
      if (!hasAnySP) {
        const fr = await fetch(`${baseUrl}/rest/api/3/field`, { headers: jiraHeaders(email, apiToken) });
        if (fr.ok) {
          const fields = await fr.json();
          const sp = fields.find(f => /story\s*points/i.test(f.name));
          if (sp) storyPointField = sp.id;
        }
      }
      meta.storyPointField = storyPointField;
      rows = (data.issues || []).map(i => ({
        Action: (i.fields.status?.name || '').toLowerCase() === 'done' || (i.fields.status?.statusCategory?.key === 'done') ? 'Completed' : 'NotCompleted',
        Key: i.key,
        Added: '',
        Summary: i.fields.summary,
        IssueType: i.fields.issuetype?.name,
        Priority: i.fields.priority?.name,
        Status: i.fields.status?.name,
        Assignee: i.fields.assignee?.displayName || '',
        PointsInitial: null,
        PointsFinal: typeof i.fields[storyPointField] === 'number' ? i.fields[storyPointField] : null,
        PointsChange: null,
      }));
    }

    res.json({ sprintId, rows, totals, meta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error building sprint report', details: String(err) });
  }
});

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
