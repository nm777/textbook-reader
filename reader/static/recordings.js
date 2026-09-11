"use strict";

const status = document.querySelector("#status");
const recordingsList = document.querySelector("#recordings-list");

async function loadRecordings() {
  try {
    const response = await fetch("../api/recordings");
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!Array.isArray(result.recordings)) throw new Error();

    recordingsList.replaceChildren(...result.recordings.map((recording) => {
      const created = new Date(recording.created_at);
      const expires = new Date(recording.expires_at);
      const item = document.createElement("li");
      item.className = "recording-card";

      const link = document.createElement("a");
      link.href = `../api/recordings/${encodeURIComponent(recording.id)}`;
      link.download = "";
      link.textContent = `Download recording from ${created.toLocaleString()}`;

      const retention = document.createElement("p");
      retention.textContent = `Available until ${expires.toLocaleString()}.`;
      item.append(link, retention);
      return item;
    }));

    recordingsList.hidden = result.recordings.length === 0;
    status.textContent = result.recordings.length
      ? `${result.recordings.length} ${result.recordings.length === 1 ? "recording is" : "recordings are"} available.`
      : "No recordings are available. New recordings remain here for seven days.";
  } catch {
    status.dataset.state = "failed";
    status.textContent = "Recordings could not be loaded. Refresh the page to try again.";
  } finally {
    status.setAttribute("aria-busy", "false");
  }
}

loadRecordings();
