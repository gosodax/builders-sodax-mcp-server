# Health Status Topbar

A slim live-status bar at the top of the landing page that fetches from the `/health` endpoint and auto-refreshes every 60 seconds.

---

## What It Shows

| Indicator | Source | Example |
|-----------|--------|---------|
| **Status** | Green/red dot + "Online"/"Offline" | 🟢 Online |
| **Uptime** | `process.uptime()` via `/health` | 3h 12m |
| **Tools** | Total tool count from `/health` | 15 available |

---

## 1. Enhance `/health` Endpoint

Add `uptime_seconds` and a `tools` breakdown to your health response:

```ts
app.get("/health", async (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: "my-mcp-server",
    version: "1.0.0",
    uptime_seconds: Math.floor(process.uptime()),
    tools: {
      total: 15,        // sum of all tool groups
      groupA: 10,       // adjust to your groups
      groupB: 5
    }
  });
});
```

---

## 2. HTML — Status Bar Markup

Place this **before** the hero section, right after `<body>`:

```html
<div class="status-bar" role="status" aria-live="polite">
  <div class="status-bar-item">
    <span class="status-dot" id="status-dot"></span>
    <span class="status-bar-value" id="status-text">Checking…</span>
  </div>
  <div class="status-bar-item">
    <span class="status-bar-label">Uptime</span>
    <span class="status-bar-value" id="status-uptime">—</span>
  </div>
  <div class="status-bar-item">
    <span class="status-bar-label">Tools</span>
    <span class="status-bar-value" id="status-tools">—</span>
  </div>
</div>
```

---

## 3. CSS

```css
.status-bar {
  background: var(--espresso);          /* dark background */
  color: var(--cream);
  font-size: 0.75rem;
  padding: 0.4rem 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
}

.status-bar-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--clay);              /* grey when loading */
  flex-shrink: 0;
}

.status-dot.online {
  background: #4ade80;
  box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
}

.status-dot.offline {
  background: #f87171;
}

.status-bar-label {
  color: var(--clay-light);
}

.status-bar-value {
  color: var(--cream-white);
  font-weight: 500;
}

@media (max-width: 480px) {
  .status-bar {
    gap: 0.75rem;
    font-size: 0.6875rem;
  }
}
```

---

## 4. JavaScript

Add this inside your existing `<script>` block:

```js
(function() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const uptime = document.getElementById('status-uptime');
  const tools = document.getElementById('status-tools');

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  async function checkHealth() {
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      const data = await res.json();
      dot.className = 'status-dot online';
      text.textContent = 'Online';
      uptime.textContent = formatUptime(data.uptime_seconds || 0);
      tools.textContent = (data.tools?.total || 0) + ' available';
    } catch {
      dot.className = 'status-dot offline';
      text.textContent = 'Offline';
      uptime.textContent = '—';
      tools.textContent = '—';
    }
  }

  checkHealth();
  setInterval(checkHealth, 60000); // refresh every 60s
})();
```

---

## Key Points

- **No external dependencies** — pure fetch + DOM manipulation.
- **Graceful degradation** — shows "Offline" if `/health` is unreachable.
- **60-second polling** — lightweight, no WebSocket needed.
- **Accessible** — uses `role="status"` and `aria-live="polite"` for screen readers.
- Adapt the CSS variables (`--espresso`, `--cream`, etc.) to match your project's design system.
