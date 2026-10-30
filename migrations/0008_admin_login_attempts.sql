-- The budget for ADMIN_PASSWORD guesses. One global row, because password
-- sign-in has no account to key on: `attempts` counts since `window_started_at`.

CREATE TABLE admin_login_attempts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);
