let map;
let markers = [];
let stream;
let pollTimer = null;
let currentLinkId = null;
let lastTimestamp = 0;
const linkSelect = document.getElementById("linkSelect");
const tbody = document.querySelector("#eventsTable tbody");
const admName = document.getElementById("admName");
const admUrl = document.getElementById("admUrl");
const admTrackingWindow = document.getElementById("admTrackingWindow");
const admCreateBtn = document.getElementById("admCreateBtn");
const admCreateResult = document.getElementById("admCreateResult");
const exportBtn = document.getElementById("exportBtn");
const deleteLinkBtn = document.getElementById("deleteLinkBtn");
const clientMarkers = {};
const clientPaths = {};

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
}

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

async function loadLinks() {
  const res = await fetch("/api/links");
  const links = await res.json();
  linkSelect.innerHTML = "";
  links.forEach((l) => {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.name || l.id;
    linkSelect.appendChild(o);
  });
  if (links.length) loadEvents(links[0].id);
}

function appendEvent(e) {
  const tr = document.createElement("tr");
  const t = new Date(e.timestamp).toLocaleString();
  const lat = e.lat != null ? e.lat.toFixed(6) : "";
  const lng = e.lng != null ? e.lng.toFixed(6) : "";
  const acc = e.accuracy != null ? e.accuracy.toFixed(1) : "";
  const ip = e.ip || "";
  const img = e.image ? `<img src="${e.image}" class="thumb"/>` : "";
  tr.innerHTML = `<td>${t}</td><td>${e.status}</td><td>${lat}</td><td>${lng}</td><td>${acc}</td><td>${ip}</td><td>${img}</td><td><button data-id="${e.id}">Delete</button></td>`;
  tbody.appendChild(tr);
  if (e.lat != null && e.lng != null) {
    if (e.clientId) {
      if (!clientMarkers[e.clientId]) {
        clientMarkers[e.clientId] = L.marker([e.lat, e.lng]).addTo(map);
        clientPaths[e.clientId] = L.polyline([[e.lat, e.lng]], { color: "#38bdf8" }).addTo(map);
      } else {
        clientMarkers[e.clientId].setLatLng([e.lat, e.lng]);
        clientPaths[e.clientId].addLatLng([e.lat, e.lng]);
      }
    } else {
      const m = L.marker([e.lat, e.lng]).addTo(map);
      markers.push(m);
    }
    const pts = [
      ...Object.values(clientMarkers).map((mk) => mk.getLatLng()),
      ...markers.map((mk) => mk.getLatLng())
    ];
    if (pts.length) {
      const bounds = L.latLngBounds(pts);
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }
}

function renderEvents(events) {
  tbody.innerHTML = "";
  clearMarkers();
  Object.values(clientMarkers).forEach((m) => m.remove());
  Object.values(clientPaths).forEach((p) => p.remove());
  for (const k in clientMarkers) delete clientMarkers[k];
  for (const k in clientPaths) delete clientPaths[k];
  events.forEach((e) => appendEvent(e));
}

function subscribeStream(linkId) {
  if (stream) stream.close();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  currentLinkId = linkId;
  stream = new EventSource(`/api/events/stream?linkId=${encodeURIComponent(linkId)}`);
  stream.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.linkId !== linkId) return;
    appendEvent(e);
    if (e.timestamp && e.timestamp > lastTimestamp) lastTimestamp = e.timestamp;
  };
  stream.onerror = () => {
    try { stream.close(); } catch {}
    startPolling(linkId);
  };
}

function startPolling(linkId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/events?linkId=${encodeURIComponent(linkId)}`);
      const events = await res.json();
      renderEvents(events);
      const maxTs = events.reduce((m, e) => Math.max(m, e.timestamp || 0), lastTimestamp);
      lastTimestamp = maxTs;
    } catch {}
  }, 3000);
}

async function loadEvents(linkId) {
  const res = await fetch(`/api/events?linkId=${encodeURIComponent(linkId)}`);
  const events = await res.json();
  renderEvents(events);
  subscribeStream(linkId);
}

tbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const res = await fetch(`/api/event/${id}`, { method: "DELETE" });
  if (res.ok) loadEvents(linkSelect.value);
});

linkSelect.addEventListener("change", () => {
  loadEvents(linkSelect.value);
});

initMap();
loadLinks();

if (admCreateBtn) {
  admCreateBtn.addEventListener("click", async () => {
    const name = admName.value.trim();
    const redirectUrl = admUrl.value.trim();
    const trackingWindow = parseInt(admTrackingWindow.value) * 60000; // Convert minutes to ms
    admCreateBtn.disabled = true;
    admCreateResult.textContent = "";
    try {
      const res = await fetch("/api/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, redirectUrl, trackingWindow })
      });
      if (!res.ok) {
        admCreateResult.textContent = "Invalid URL";
      } else {
        const data = await res.json();
        const a = document.createElement("a");
        a.href = data.url;
        a.textContent = data.url;
        admCreateResult.textContent = "Share this link: ";
        admCreateResult.appendChild(a);
        const o = document.createElement("option");
        o.value = data.id;
        o.textContent = name || data.id;
        linkSelect.appendChild(o);
        linkSelect.value = data.id;
        loadEvents(data.id);
      }
    } catch (e) {
      admCreateResult.textContent = "Error creating link";
    } finally {
      admCreateBtn.disabled = false;
    }
  });
}

if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    const linkId = linkSelect.value;
    if (!linkId) return;
    window.open(`/api/export/csv?linkId=${encodeURIComponent(linkId)}`, "_blank");
  });
}

if (deleteLinkBtn) {
  deleteLinkBtn.addEventListener("click", async () => {
    const linkId = linkSelect.value;
    if (!linkId) return;
    if (!confirm("Are you sure you want to delete this link and all its events?")) return;
    
    try {
      const res = await fetch(`/api/link/${linkId}`, { method: "DELETE" });
      if (res.ok) {
        loadLinks();
        alert("Link deleted successfully");
      } else {
        alert("Error deleting link");
      }
    } catch (e) {
      alert("Error deleting link");
    }
  });
}
