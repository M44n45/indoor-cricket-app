-- seed_players.sql
INSERT INTO players (name, is_common_player) VALUES
('Abhinav', false), ('Robin', false), ('Maanas', false), ('Varun', false), ('Prateek', false),
('Kailas', false), ('Arshad', false), ('Hrushikesh', false), ('Sameer', false), ('Kapil', false),
('Vaibhav', false), ('Bijon', false), ('Tushit', false), ('Jitesh', false), ('Amit', false),
('Sundeep', false), ('Chinmay', false), ('Anuj', false), ('Anshu', false), ('Saurabh', false),
('Rahul', false), ('Cecil', false)
ON CONFLICT DO NOTHING;
