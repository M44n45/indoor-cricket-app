-- schema.sql
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_common_player BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  match_date DATE NOT NULL DEFAULT CURRENT_DATE,
  overs_limit NUMERIC(5,2) NOT NULL DEFAULT 8,
  retirement_overs NUMERIC(5,2) NOT NULL DEFAULT 2,
  team_a_name TEXT NOT NULL,
  team_b_name TEXT NOT NULL,
  status TEXT DEFAULT 'setup', -- setup, in_progress, completed
  winner_team TEXT, -- 'A' or 'B' or 'tie'
  result_summary TEXT,
  current_innings INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_players (
  id SERIAL PRIMARY KEY,
  match_id INT REFERENCES matches(id) ON DELETE CASCADE,
  player_id INT REFERENCES players(id),
  team TEXT NOT NULL CHECK (team IN ('A','B')),
  UNIQUE(match_id, player_id, team)
);

CREATE TABLE IF NOT EXISTS innings (
  id SERIAL PRIMARY KEY,
  match_id INT REFERENCES matches(id) ON DELETE CASCADE,
  innings_no INT NOT NULL,
  batting_team TEXT NOT NULL CHECK (batting_team IN ('A','B')),
  bowling_team TEXT NOT NULL CHECK (bowling_team IN ('A','B')),
  total_runs INT DEFAULT 0,
  total_wickets INT DEFAULT 0,
  overs_completed NUMERIC(4,1) DEFAULT 0,
  total_legal_balls INT DEFAULT 0,
  wide_runs INT DEFAULT 0,
  no_ball_runs INT DEFAULT 0,
  striker_id INT REFERENCES players(id),
  bowler_id INT REFERENCES players(id),
  status TEXT DEFAULT 'in_progress', -- in_progress, completed
  UNIQUE(match_id, innings_no)
);

CREATE TABLE IF NOT EXISTS batting_records (
  id SERIAL PRIMARY KEY,
  innings_id INT REFERENCES innings(id) ON DELETE CASCADE,
  player_id INT REFERENCES players(id),
  runs INT DEFAULT 0,
  balls_faced INT DEFAULT 0,
  fours INT DEFAULT 0,
  sixes INT DEFAULT 0,
  status TEXT DEFAULT 'yet_to_bat', -- yet_to_bat, batting, retired, out
  retirement_count INT DEFAULT 0,
  batting_order INT,
  dismissal_type TEXT, -- bowled, caught, run_out, stumped, other
  bowler_id INT REFERENCES players(id),
  fielder_id INT REFERENCES players(id),
  dismissal_over NUMERIC(4,1),
  UNIQUE(innings_id, player_id)
);

CREATE TABLE IF NOT EXISTS bowling_records (
  id SERIAL PRIMARY KEY,
  innings_id INT REFERENCES innings(id) ON DELETE CASCADE,
  player_id INT REFERENCES players(id),
  overs_bowled NUMERIC(4,1) DEFAULT 0,
  runs_conceded INT DEFAULT 0,
  wickets INT DEFAULT 0,
  UNIQUE(innings_id, player_id)
);

CREATE TABLE IF NOT EXISTS ball_events (
  id SERIAL PRIMARY KEY,
  innings_id INT REFERENCES innings(id) ON DELETE CASCADE,
  over_no INT NOT NULL,
  ball_no INT NOT NULL,
  batsman_id INT REFERENCES players(id),
  bowler_id INT REFERENCES players(id),
  runs INT DEFAULT 0,
  extra_type TEXT, -- null, wide, no_ball, bye, leg_bye
  extra_runs INT DEFAULT 0,
  is_wicket BOOLEAN DEFAULT FALSE,
  wicket_type TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ball_events_innings ON ball_events(innings_id);
CREATE INDEX IF NOT EXISTS idx_batting_innings ON batting_records(innings_id);
CREATE INDEX IF NOT EXISTS idx_bowling_innings ON bowling_records(innings_id);

CREATE TABLE IF NOT EXISTS fall_of_wickets (
  id SERIAL PRIMARY KEY,
  innings_id INT REFERENCES innings(id) ON DELETE CASCADE,
  wicket_no INT NOT NULL,
  team_score_at_fall INT NOT NULL,
  player_id INT REFERENCES players(id),
  over_at_fall NUMERIC(4,1),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_availability (
  id SERIAL PRIMARY KEY,
  match_id INT REFERENCES matches(id) ON DELETE CASCADE,
  player_id INT REFERENCES players(id),
  UNIQUE(match_id, player_id)
);

CREATE TABLE IF NOT EXISTS external_leaderboard (
  id SERIAL PRIMARY KEY,
  source_label TEXT, -- e.g. filename or 'Week 12 upload'
  player_name TEXT NOT NULL,
  matches_played INT DEFAULT 0,
  innings_played INT DEFAULT 0,
  runs INT DEFAULT 0,
  fours INT DEFAULT 0,
  sixes INT DEFAULT 0,
  avg NUMERIC(6,2) DEFAULT 0,
  strike_rate NUMERIC(6,2) DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  win_pct NUMERIC(5,2) DEFAULT 0,
  wickets INT DEFAULT 0,
  innings_bowled INT DEFAULT 0,
  overs_bowled NUMERIC(6,1) DEFAULT 0,
  runs_conceded INT DEFAULT 0,
  economy NUMERIC(6,2) DEFAULT 0,
  best_bowling TEXT,
  uploaded_at TIMESTAMP DEFAULT NOW()
);
