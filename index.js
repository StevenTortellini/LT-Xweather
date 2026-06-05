require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();

const config = {
  port: Number(process.env.PORT || 3000),
  clientId: process.env.XWEATHER_CLIENT_ID,
  clientSecret: process.env.XWEATHER_CLIENT_SECRET,
  location: process.env.XWEATHER_LOCATION || "hopkinsville,ky",
  radius: process.env.XWEATHER_RADIUS || "10mi",
  countdownMinutes: Number(process.env.LIGHTNING_COUNTDOWN_MINUTES || 30),
  pollIntervalMs: Number(process.env.XWEATHER_POLL_SECONDS || 120) * 1000,
  limit: Number(process.env.XWEATHER_LIMIT || 100),
};

const state = {
  active: false,
  configured: Boolean(config.clientId && config.clientSecret),
  lastCheckedAt: null,
  lastLightningAt: null,
  clearsAt: null,
  remainingSeconds: 0,
  source: "lightning",
  location: config.location,
  radius: config.radius,
  summary: "Waiting for first Xweather lightning check.",
  action: "Monitoring for nearby lightning.",
  error: null,
  strikeCount: 0,
  cloudToGroundCount: 0,
  intracloudCount: 0,
  closestDistanceMI: null,
  closestDirection: null,
  latestType: null,
  latestPeakAmp: null,
  latestSensors: null,
  latestConfidence: null,
  latestReceivedAt: null,
  strikes: [],
};

function toIso(timestampSeconds) {
  if (!timestampSeconds) return null;
  return new Date(timestampSeconds * 1000).toISOString();
}

function pulseTypeLabel(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "cg") return "Cloud-to-ground";
  if (normalized === "ic") return "Intracloud";
  return type || "Unknown";
}

function formatMiles(value) {
  return typeof value === "number" ? `${value.toFixed(1)} mi` : "--";
}

function normalizeStrike(record) {
  const pulse = record?.ob?.pulse || {};

  return {
    id: record?.id || null,
    observedAt: record?.ob?.dateTimeISO || toIso(record?.ob?.timestamp),
    receivedAt: record?.recISO || toIso(record?.recTimestamp),
    ageSeconds: record?.ob?.age ?? record?.age ?? null,
    type: pulseTypeLabel(pulse.type),
    rawType: String(pulse.type || "").toLowerCase(),
    peakAmp: typeof pulse.peakamp === "number" ? pulse.peakamp : null,
    sensors: typeof pulse.numSensors === "number" ? pulse.numSensors : null,
    chiSquare: typeof pulse.chiSquare === "number" ? pulse.chiSquare : null,
    lat: record?.loc?.lat ?? null,
    long: record?.loc?.long ?? null,
    distanceMI: record?.relativeTo?.distanceMI ?? null,
    distanceKM: record?.relativeTo?.distanceKM ?? null,
    direction: record?.relativeTo?.bearingENG || null,
  };
}

function normalizeXweatherResponse(payload) {
  const records = Array.isArray(payload?.response) ? payload.response : [];
  const strikes = records
    .map(normalizeStrike)
    .sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0));

  if (strikes.length === 0) {
    return {
      detected: false,
      strikes: [],
      summary: `No lightning detected within ${config.radius} of ${config.location}.`,
      action: "All clear. Continue normal activity.",
    };
  }

  const nearest = [...strikes].sort((a, b) => {
    const left = typeof a.distanceMI === "number" ? a.distanceMI : Number.POSITIVE_INFINITY;
    const right = typeof b.distanceMI === "number" ? b.distanceMI : Number.POSITIVE_INFINITY;
    return left - right;
  })[0];
  const latest = strikes[0];
  const cloudToGroundCount = strikes.filter((strike) => strike.rawType === "cg").length;
  const intracloudCount = strikes.filter((strike) => strike.rawType === "ic").length;

  return {
    detected: true,
    strikes,
    latest,
    nearest,
    cloudToGroundCount,
    intracloudCount,
    detectedAt: latest.observedAt,
    summary: `${strikes.length} lightning event${strikes.length === 1 ? "" : "s"} detected within ${config.radius}. Closest strike: ${formatMiles(nearest.distanceMI)} ${nearest.direction || ""}.`.trim(),
    action: `Clear the area until ${config.countdownMinutes} minutes after the last detected lightning event.`,
  };
}

function updateCountdown(detection) {
  const now = Date.now();
  state.lastCheckedAt = new Date(now).toISOString();
  state.error = null;
  state.summary = detection.summary;
  state.action = detection.action;

  if (detection.detected) {
    const detectedAtMs = detection.detectedAt ? Date.parse(detection.detectedAt) : now;
    const clearsAtMs = detectedAtMs + config.countdownMinutes * 60 * 1000;

    state.active = clearsAtMs > now;
    state.lastLightningAt = new Date(detectedAtMs).toISOString();
    state.clearsAt = new Date(Math.max(clearsAtMs, now)).toISOString();
    state.strikeCount = detection.strikes.length;
    state.cloudToGroundCount = detection.cloudToGroundCount;
    state.intracloudCount = detection.intracloudCount;
    state.closestDistanceMI = detection.nearest?.distanceMI ?? null;
    state.closestDirection = detection.nearest?.direction ?? null;
    state.latestType = detection.latest?.type ?? null;
    state.latestPeakAmp = detection.latest?.peakAmp ?? null;
    state.latestSensors = detection.latest?.sensors ?? null;
    state.latestConfidence = detection.latest?.chiSquare ?? null;
    state.latestReceivedAt = detection.latest?.receivedAt ?? null;
    state.strikes = detection.strikes.slice(0, 6);
  } else if (state.clearsAt && Date.parse(state.clearsAt) > now) {
    state.active = true;
  } else {
    state.active = false;
    state.clearsAt = null;
    state.strikeCount = 0;
    state.cloudToGroundCount = 0;
    state.intracloudCount = 0;
    state.closestDistanceMI = null;
    state.closestDirection = null;
    state.latestType = null;
    state.latestPeakAmp = null;
    state.latestSensors = null;
    state.latestConfidence = null;
    state.latestReceivedAt = null;
    state.strikes = [];
  }

  updateRemainingSeconds();
}

async function pollXweather() {
  if (!state.configured) {
    state.error = "Missing XWEATHER_CLIENT_ID or XWEATHER_CLIENT_SECRET.";
    state.summary = "Server is not configured for Xweather yet.";
    state.action = "Add credentials to .env, then restart the server.";
    return;
  }

  try {
    const endpoint = `https://data.api.xweather.com/lightning/${encodeURIComponent(config.location)}`;

    const response = await axios.get(endpoint, {
      timeout: 10000,
      params: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        radius: config.radius,
        limit: config.limit,
      },
    });

    updateCountdown(normalizeXweatherResponse(response.data));
  } catch (error) {
    state.lastCheckedAt = new Date().toISOString();
    state.error = error.response?.data?.error?.description || error.response?.data || error.message;
    state.summary = "Could not refresh Xweather lightning data. Keeping the last countdown state.";
    state.action = "Verify credentials, location, radius, and API access.";
    updateRemainingSeconds();
  }
}

function updateRemainingSeconds() {
  const now = Date.now();
  state.remainingSeconds = state.clearsAt
    ? Math.max(0, Math.ceil((Date.parse(state.clearsAt) - now) / 1000))
    : 0;
  state.active = state.remainingSeconds > 0;
}

app.get("/api/lightning-status", (req, res) => {
  updateRemainingSeconds();
  res.json(state);
});

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lightning Delay - ${config.location}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, sans-serif;
    background: #A32D2D;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    text-align: center;
  }
  body.clear { background: #246B45; }
  body.pending { background: #7A5A20; }
  .warning-lbl {
    font-size: 13px;
    font-weight: bold;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: #F7C1C1;
    margin-bottom: .5rem;
  }
  body.clear .warning-lbl { color: #BDE8CE; }
  body.pending .warning-lbl { color: #FFE4AC; }
  .pulse-ring {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #FCEBEB;
    animation: blink 1s step-start infinite;
    margin-right: 8px;
    vertical-align: middle;
  }
  body.clear .pulse-ring { animation: none; background: #DFF8E8; }
  body.pending .pulse-ring { background: #FFF4D7; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    margin-bottom: 1.5rem;
  }
  .tri-wrap { position: relative; width: 44px; height: 38px; flex: 0 0 auto; }
  .tri {
    width: 0; height: 0;
    border-left: 22px solid transparent;
    border-right: 22px solid transparent;
    border-bottom: 38px solid #FCEBEB;
  }
  .bolt {
    position: absolute;
    top: 8px; left: 50%;
    transform: translateX(-50%);
    color: #A32D2D;
    font-size: 22px;
    font-weight: bold;
    line-height: 1;
  }
  body.clear .bolt { color: #246B45; }
  body.pending .bolt { color: #7A5A20; }
  .big-title {
    font-size: clamp(42px, 8vw, 72px);
    font-weight: bold;
    color: #FCEBEB;
    line-height: 1;
    margin-bottom: .75rem;
  }
  .location {
    font-size: clamp(18px, 3.5vw, 28px);
    font-weight: bold;
    color: #F7C1C1;
    margin-bottom: 1.2rem;
  }
  body.clear .big-title, body.clear .time-val, body.clear .action, body.clear .step-txt { color: #E8FFF0; }
  body.clear .location, body.clear .sub { color: #BDE8CE; }
  body.pending .big-title, body.pending .time-val, body.pending .action, body.pending .step-txt { color: #FFF4D7; }
  body.pending .location, body.pending .sub { color: #FFE4AC; }
  .countdown {
    font-variant-numeric: tabular-nums;
    font-size: clamp(68px, 13vw, 150px);
    font-weight: bold;
    color: #FCEBEB;
    line-height: .95;
    margin-bottom: 1.2rem;
  }
  .divider {
    width: 60px; height: 2px;
    background: #F09595;
    border-radius: 2px;
    margin: 0 auto 2rem;
  }
  body.clear .divider { background: #8ED7A7; }
  body.pending .divider { background: #FFD273; }
  .action {
    font-size: clamp(22px, 4.5vw, 40px);
    font-weight: bold;
    color: #FCEBEB;
    margin-bottom: .75rem;
    line-height: 1.2;
  }
  .sub {
    font-size: clamp(14px, 2.5vw, 20px);
    color: #F7C1C1;
    margin-bottom: 2rem;
    line-height: 1.5;
    max-width: 960px;
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 14px;
    margin-bottom: 2rem;
    max-width: 1000px;
  }
  .step {
    background: rgba(252,235,235,0.12);
    border: 1px solid rgba(247,193,193,0.3);
    border-radius: 8px;
    padding: 16px 20px;
    min-width: 160px;
    flex: 1;
  }
  body.clear .step { background: rgba(232,255,240,0.12); border-color: rgba(189,232,206,0.34); }
  body.pending .step { background: rgba(255,244,215,0.12); border-color: rgba(255,228,172,0.34); }
  .step-num {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #F09595;
    margin-bottom: 6px;
  }
  body.clear .step-num { color: #8ED7A7; }
  body.pending .step-num { color: #FFD273; }
  .step-txt {
    font-size: clamp(13px, 2vw, 16px);
    color: #FCEBEB;
    line-height: 1.4;
  }
  .time-row {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.2rem;
    max-width: 1100px;
  }
  .time-block { text-align: center; min-width: 130px; }
  .time-lbl {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #F09595;
    margin-bottom: 4px;
  }
  body.clear .time-lbl { color: #8ED7A7; }
  body.pending .time-lbl { color: #FFD273; }
  .time-val {
    font-size: clamp(16px, 2.5vw, 22px);
    font-weight: bold;
    color: #FCEBEB;
  }
  .footer-txt {
    font-size: 12px;
    color: #F09595;
    margin-top: 1rem;
    line-height: 1.4;
  }
  body.clear .footer-txt { color: #8ED7A7; }
  body.pending .footer-txt { color: #FFD273; }
</style>
</head>
<body class="pending">
  <div class="warning-lbl">
    <span class="pulse-ring"></span><span id="status-label">Xweather - Lightning Monitor</span>
  </div>

  <div class="top-bar">
    <div class="tri-wrap">
      <div class="tri"></div>
      <div class="bolt">!</div>
    </div>
    <div id="title" class="big-title">Lightning Monitor</div>
    <div class="tri-wrap">
      <div class="tri"></div>
      <div class="bolt">!</div>
    </div>
  </div>

  <div id="location" class="location">${config.location} - ${config.radius} radius</div>
  <div id="countdown" class="countdown">--:--</div>
  <div class="divider"></div>

  <div id="action" class="action">Connecting to Xweather</div>
  <div id="summary" class="sub">Waiting for the server to load current lightning status.</div>

  <div class="steps">
    <div class="step">
      <div class="step-num">Step 1</div>
      <div class="step-txt">Suspend outdoor activity when lightning is detected nearby</div>
    </div>
    <div class="step">
      <div class="step-num">Step 2</div>
      <div class="step-txt">Move guests and staff indoors or to designated shelter</div>
    </div>
    <div class="step">
      <div class="step-num">Step 3</div>
      <div class="step-txt">Reset the countdown after each new lightning event</div>
    </div>
    <div class="step">
      <div class="step-num">Step 4</div>
      <div class="step-txt">Resume only after the countdown reaches all clear</div>
    </div>
  </div>

  <div class="time-row">
    <div class="time-block">
      <div class="time-lbl">Last Lightning</div>
      <div id="last-lightning" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">All Clear At</div>
      <div id="clear-time" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">Strikes</div>
      <div id="strike-count" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">Closest</div>
      <div id="closest" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">Latest Type</div>
      <div id="latest-type" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">Peak Amps</div>
      <div id="peak-amp" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">Sensors</div>
      <div id="sensors" class="time-val">--</div>
    </div>
    <div class="time-block">
      <div class="time-lbl">CG / IC</div>
      <div id="pulse-mix" class="time-val">--</div>
    </div>
  </div>

  <div id="footer" class="footer-txt">Xweather Lightning - awaiting first check</div>

  <script>
    const statusLabelEl = document.getElementById("status-label");
    const titleEl = document.getElementById("title");
    const locationEl = document.getElementById("location");
    const countdownEl = document.getElementById("countdown");
    const actionEl = document.getElementById("action");
    const summaryEl = document.getElementById("summary");
    const lastLightningEl = document.getElementById("last-lightning");
    const clearTimeEl = document.getElementById("clear-time");
    const strikeCountEl = document.getElementById("strike-count");
    const closestEl = document.getElementById("closest");
    const latestTypeEl = document.getElementById("latest-type");
    const peakAmpEl = document.getElementById("peak-amp");
    const sensorsEl = document.getElementById("sensors");
    const pulseMixEl = document.getElementById("pulse-mix");
    const footerEl = document.getElementById("footer");

    let latestStatus = null;

    function formatDuration(totalSeconds) {
      const seconds = Math.max(0, Number(totalSeconds || 0));
      const minutes = Math.floor(seconds / 60);
      const remaining = seconds % 60;
      return String(minutes).padStart(2, "0") + ":" + String(remaining).padStart(2, "0");
    }

    function formatTime(value) {
      if (!value) return "--";
      return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    function formatDateTime(value) {
      if (!value) return "--";
      return new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }

    function formatMiles(value) {
      return typeof value === "number" ? value.toFixed(1) + " mi" : "--";
    }

    function formatAmp(value) {
      return typeof value === "number" ? Math.round(value).toLocaleString() : "--";
    }

    function render(status) {
      latestStatus = status;

      const pageClass = status.error ? "pending" : status.active ? "" : "clear";
      document.body.className = pageClass;

      statusLabelEl.textContent = status.error
        ? "Xweather - Configuration Alert"
        : status.active
          ? "Xweather - Active Lightning Delay"
          : "Xweather - Lightning Monitor";
      titleEl.textContent = status.error ? "Monitor Alert" : status.active ? "Lightning Delay" : "All Clear";
      locationEl.textContent = (status.location || "Selected location") + " - " + (status.radius || "configured") + " radius";
      countdownEl.textContent = status.active ? formatDuration(status.remainingSeconds) : "CLEAR";
      actionEl.textContent = status.error || status.action || "";
      summaryEl.textContent = status.summary || "";
      lastLightningEl.textContent = formatTime(status.lastLightningAt);
      clearTimeEl.textContent = formatTime(status.clearsAt);
      strikeCountEl.textContent = String(status.strikeCount || 0);
      closestEl.textContent = formatMiles(status.closestDistanceMI) + (status.closestDirection ? " " + status.closestDirection : "");
      latestTypeEl.textContent = status.latestType || "--";
      peakAmpEl.textContent = formatAmp(status.latestPeakAmp);
      sensorsEl.textContent = status.latestSensors ?? "--";
      pulseMixEl.textContent = (status.cloudToGroundCount || 0) + " / " + (status.intracloudCount || 0);
      footerEl.textContent = "Checked " + formatDateTime(status.lastCheckedAt) + " - Source: Xweather lightning endpoint - Data window: recent real-time lightning";
    }

    async function refresh() {
      try {
        const response = await fetch("/api/lightning-status", { cache: "no-store" });
        render(await response.json());
      } catch (error) {
        render({
          active: false,
          error: "Countdown server is unavailable.",
          remainingSeconds: 0,
          summary: error.message,
        });
      }
    }

    setInterval(() => {
      if (!latestStatus || !latestStatus.active) return;
      latestStatus.remainingSeconds = Math.max(0, latestStatus.remainingSeconds - 1);
      render(latestStatus);
    }, 1000);

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`);
});

pollXweather();
setInterval(pollXweather, config.pollIntervalMs);

app.listen(config.port, () => {
  console.log(`Lightning countdown server running at http://localhost:${config.port}`);
});
