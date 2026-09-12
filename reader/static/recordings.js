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
      let savedName = typeof recording.name === "string" ? recording.name : "";
      const item = document.createElement("li");
      item.className = "recording-card";

      const link = document.createElement("a");
      link.href = `../api/recordings/${encodeURIComponent(recording.id)}`;
      link.download = "";

      const retention = document.createElement("p");
      retention.textContent = `Available until ${expires.toLocaleString()}.`;

      const nameForm = document.createElement("form");
      nameForm.className = "recording-name-form";
      const nameLabel = document.createElement("label");
      const nameInput = document.createElement("input");
      nameInput.id = `recording-name-${recording.id}`;
      nameInput.type = "text";
      nameInput.maxLength = 100;
      nameInput.autocomplete = "off";
      nameInput.value = savedName;
      nameLabel.htmlFor = nameInput.id;
      nameLabel.textContent = "Recording name (optional)";
      const saveButton = document.createElement("button");
      saveButton.type = "submit";
      saveButton.textContent = "Save name";

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";

      function updateNameDisplay() {
        const description = savedName || `recording from ${created.toLocaleString()}`;
        link.textContent = `Download ${description}`;
        deleteButton.setAttribute("aria-label", `Delete ${description}`);
      }

      nameForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const nextName = nameInput.value.replace(/\s+/g, " ").trim();
        nameInput.value = nextName;
        nameInput.disabled = true;
        saveButton.disabled = true;
        try {
          const response = await fetch(link.href, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nextName || null }),
          });
          if (response.status === 404) {
            item.remove();
            updateStatus();
            return;
          }
          if (!response.ok) throw new Error();
          savedName = nextName;
          updateNameDisplay();
          status.dataset.state = "success";
          status.textContent = "Recording name saved.";
        } catch {
          status.dataset.state = "failed";
          status.textContent = "The recording name could not be saved. Try again.";
        } finally {
          nameInput.disabled = false;
          saveButton.disabled = false;
        }
      });

      deleteButton.addEventListener("click", async () => {
        const description = savedName || `recording from ${created.toLocaleString()}`;
        if (!window.confirm(`Delete ${description}? This cannot be undone.`)) return;
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

      updateNameDisplay();
      nameForm.append(nameLabel, nameInput, saveButton);
      item.append(link, retention, nameForm, deleteButton);
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
