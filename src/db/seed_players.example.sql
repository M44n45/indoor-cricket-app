-- seed_players.example.sql
--
-- This is a TEMPLATE, not live data. The app does not read this file
-- directly — src/db/seed_players.sql (the real roster) is gitignored, so a
-- fresh clone of this repo starts with zero players, not someone else's
-- friend group.
--
-- To pre-seed your own roster on first boot:
--   1. Copy this file to seed_players.sql in the same folder.
--   2. Replace the names below with your own players.
--   3. Rebuild/restart the app — it seeds automatically the first time it
--      finds an empty players table.
--
-- Not interested in pre-seeding? Skip this entirely — you can add players
-- anytime from the Setup screen in the app instead.

INSERT INTO players (name, is_common_player) VALUES
('Player One', false), ('Player Two', false), ('Player Three', false)
ON CONFLICT DO NOTHING;
