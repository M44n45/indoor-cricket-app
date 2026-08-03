-- Wipes all match/innings/scoring data while preserving the players table.
-- Run via: docker compose exec db psql -U <user> -d <dbname> -f cleanup_matches.sql
TRUNCATE TABLE matches RESTART IDENTITY CASCADE;
