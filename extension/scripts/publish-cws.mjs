#!/usr/bin/env node
import fs from "node:fs";

const required = [
  "CWS_CLIENT_ID",
  "CWS_CLIENT_SECRET",
  "CWS_REFRESH_TOKEN",
  "CWS_PUBLISHER_ID",
  "CWS_EXTENSION_ID",
];

for (const name of required) {
  if (!process.env[name]) fail(`${name} is required`);
}

const zipPath = process.argv[2];
if (!zipPath) fail("Usage: node scripts/publish-cws.mjs dist-zip/prodocstore-vX.Y.Z.zip");
if (!fs.existsSync(zipPath)) fail(`Zip not found: ${zipPath}`);

const publisherId = process.env.CWS_PUBLISHER_ID;
const extensionId = process.env.CWS_EXTENSION_ID;
const itemName = `publishers/${publisherId}/items/${extensionId}`;
const accessToken = await refreshAccessToken();

const upload = await uploadZip(accessToken, itemName, zipPath);
console.log(`CWS upload state: ${upload.uploadState || "unknown"}`);

if (upload.uploadState === "IN_PROGRESS" || upload.uploadState === "UPLOAD_IN_PROGRESS") {
  await waitForUpload(accessToken, itemName);
} else if (upload.uploadState && !["SUCCEEDED", "UPLOAD_SUCCEEDED"].includes(upload.uploadState)) {
  fail(`CWS upload failed: ${JSON.stringify(upload)}`);
}

const publish = await publishItem(accessToken, itemName);
console.log(`CWS publish state: ${publish.state || "unknown"}`);
if (publish.warningInfo?.warnings?.length) {
  console.log(`CWS publish warnings: ${JSON.stringify(publish.warningInfo.warnings)}`);
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.CWS_CLIENT_ID,
    client_secret: process.env.CWS_CLIENT_SECRET,
    refresh_token: process.env.CWS_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) fail(`Could not refresh CWS access token: ${res.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function uploadZip(token, name, file) {
  const url = `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/zip",
    },
    body: fs.createReadStream(file),
    duplex: "half",
  });
  const data = await parseResponse(res);
  if (!res.ok) fail(`CWS upload failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitForUpload(token, name) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const status = await fetchStatus(token, name);
    const state = status.lastAsyncUploadState || status.uploadState;
    console.log(`CWS async upload state: ${state || "unknown"}`);
    if (state === "SUCCEEDED" || state === "UPLOAD_SUCCEEDED") return;
    if (state === "FAILED" || state === "UPLOAD_FAILED") fail(`CWS async upload failed: ${JSON.stringify(status)}`);
  }
  fail("Timed out waiting for CWS upload processing");
}

async function fetchStatus(token, name) {
  const res = await fetch(`https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await parseResponse(res);
  if (!res.ok) fail(`Could not fetch CWS status: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function publishItem(token, name) {
  const res = await fetch(`https://chromewebstore.googleapis.com/v2/${name}:publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      publishType: "DEFAULT_PUBLISH",
      blockOnWarnings: process.env.CWS_BLOCK_ON_WARNINGS !== "false",
      skipReview: process.env.CWS_SKIP_REVIEW === "true",
    }),
  });
  const data = await parseResponse(res);
  if (!res.ok) fail(`CWS publish failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function parseResponse(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
