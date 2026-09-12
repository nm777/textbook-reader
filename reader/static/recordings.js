"use strict";

const status = document.querySelector("#status");
const recordingsList = document.querySelector("#recordings-list");

function updateStatus() {
  const count = recordingsList.children.length;
  delete status.dataset.state;
  recordingsList.hidden = count === 0;
  status.textContent = count
    ? `${count} ${count === 1 ? "recording is" : "recordings are"} available.`
    : "No recordings are available. New recordings remain here for seven days.";
}

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

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.setAttribute("aria-label", `Delete recording from ${created.toLocaleString()}`);
      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Delete the recording from ${created.toLocaleString()}? This cannot be undone.`)) return;
        deleteButton.disabled = true;
        try {
          const response = await fetch(link.href, { method: "DELETE" });
          if (!response.ok && response.status !== 404) throw new Error();
          item.remove();
          updateStatus();
        } catch {
          deleteButton.disabled = false;
          status.dataset.state = "failed";
          status.textContent = "The recording could not be deleted. Try again.";
        }
      });

      item.append(link, retention, deleteButton);
      return item;
    }));

    updateStatus();
  } catch {
    status.dataset.state = "failed";
    status.textContent = "Recordings could not be loaded. Refresh the page to try again.";
  } finally {
    status.setAttribute("aria-busy", "false");
  }
}

loadRecordings();
