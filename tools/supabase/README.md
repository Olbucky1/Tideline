# Tideline accounts with Supabase (free, about 5 minutes)

1. Go to https://supabase.com, click **Start your project**, sign in with GitHub.
2. **New project**: name `tideline`, set a database password (save it somewhere), region **East US**, Free plan. Wait a minute for it to start.
3. Left sidebar → **SQL Editor** → **New query**. Paste everything from `setup.sql` in this folder, click **Run**. It should say "Success".
4. Left sidebar → **Authentication** → **URL Configuration**:
   - Site URL: `https://olbucky1.github.io/Tideline/`
   - Redirect URLs → Add: `https://olbucky1.github.io/Tideline/`
   Save.
5. Left sidebar → **Project Settings** (gear) → **API**. Copy **Project URL** and the **anon public** key.
6. In Tideline: Menu → **Account and sync** → paste both → **Connect**. Then enter your email → **Email me a sign-in link** → open the link in the same browser.

Do steps 1–5 once. On each other browser or phone: Menu → Account and sync → paste the same two values → sign in with your email.

The anon key is designed to be public. Row-level security (set up by `setup.sql`) means each person can only ever read or change their own data.
