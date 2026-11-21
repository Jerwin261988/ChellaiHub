# Company Hub

Staff portal and payroll: payslips, attendance with photo proof, leave, roster, loans, sales incentives, weekly payroll and printable summaries.

- **Database:** Supabase (Postgres)
- **Server:** Node.js, no packages to install (`server.js`)
- **Hosting:** Render, code on GitHub

## 1. Supabase (database)
1. Create a project at supabase.com.
2. Open **SQL Editor > New query**, paste everything from `supabase/schema.sql`, and run it.
3. Open **Project Settings > API** and copy:
   - **Project URL** (`SUPABASE_URL`)
   - **service_role key** (`SUPABASE_SERVICE_KEY`). Keep it secret. It goes only on the server, never in the page.

## 2. GitHub (code)
1. Create a new **private** repository.
2. Upload these files (or `git init`, `git add .`, `git commit`, `git push`). The `.env` file is never uploaded.

## 3. Render (hosting)
1. On render.com choose **New > Blueprint** and pick the repository (it reads `render.yaml`), or **New > Web Service** with
   build command `npm install` and start command `node server.js`.
2. Set these environment variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_SERVICE_KEY` | service_role key from step 1 |
| `ADMIN_USERNAME` | the admin username you want |
| `ADMIN_PASSWORD` | at least 6 characters |
| `SESSION_SECRET` | a long random text (Render can generate it) |
| `TZ` | `Asia/Manila` |

3. Deploy, then open the Render address and sign in with the admin username and password.
   The admin account is created once, on the first start. After that, change it in the **Account** tab.

## 4. Move the data from the old hub
1. In the old hub, open **Account > Download backup**.
2. On your computer, with Node 18 or newer:
   ```
   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/import-backup.js backup.json
   ```
3. Employees keep their passwords. Attendance photos are not in the backup.

## Notes
- Employees sign in with their ID and password. Admin access can also be given to an employee in their record.
- The server decides who can see what. An employee gets only their own records. Sales, history and photos are for admins only.
- Run **one** instance only (the free plan is fine). Render's free plan sleeps when idle, so the first visit can take about a minute.
- Supabase free projects pause after a week of no use. Keep using it, or upgrade for daily backups. You can also take your own backup with **Account > Download backup**.
- Photos are stored in the database. Use **Delete photos older than 60 days** in the Account tab now and then.
- Local run: copy `.env.example` to `.env`, then `node server.js`. Set `STORE=memory` to try it without Supabase.
- Check the server with `npm test` (no database needed).
