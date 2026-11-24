# Gym Coach

Workouts, animated exercise demos, muscle maps, macros, and a **Ranking** tab that compares everyone in your group.

## How it saves
- On Render (with `server.js`), everyone who opens the link shares one group: all people, workouts and food are stored in the database, so every phone sees everyone.
- Opened as a plain file or on GitHub Pages, data saves only in that phone's browser.

## Privacy
Each person sets a 4-digit PIN. Their food logs, weight, age, height and calorie targets are stored in a private doc that the server only sends or accepts with that person's PIN. Workouts, splits, strength and rankings stay shared. PINs are stored as salted scrypt hashes; 5 wrong tries locks that person for 5 minutes.

## Deploy on Render
1. In Render, choose **New → Blueprint** and pick this repo. `render.yaml` creates the web service and a Postgres database.
2. Optional: set `ADMIN_PIN` (a 4+ digit code that can unlock or reset anyone's PIN if they forget it).
3. Optional: set `GROUP_CODE` to require a code before anyone can see or save data.
4. Text people the `onrender.com` link.

Run locally: `npm install && npm start`, then open http://localhost:3000 (without `DATABASE_URL` it saves to `data.json`).
