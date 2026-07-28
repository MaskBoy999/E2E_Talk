ALTER TABLE servers ADD COLUMN invite_code_salt TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN friend_code_hash_salt TEXT DEFAULT NULL;
