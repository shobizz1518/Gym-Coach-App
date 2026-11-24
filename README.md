# Gym Coach

Workouts, animated exercise demos, muscle maps, macros, and a **Ranking** tab that compares everyone in your group.

## How it saves
- On Render (with `server.js`), everyone who opens the link shares one group: all people, workouts and food are stored in the database, so every phone sees everyone.
- Opened as a plain file or on GitHub Pages, data saves only in that phone's browser.

## Deploy on Render
1. In Render, choose **New → Blueprint** and pick this repo. `render.yaml` creates the web service and a Postgres database.
2. Optional: set `GROUP_CODE` to require a code before anyone can see or save data.
3. Text people the `onrender.com` link.

Run locally: `npm install && npm start`, then open http://localhost:3000 (without `DATABASE_URL` it saves to `data.json`).
