-- Global soundboard mute: server owner can disable soundboard for everyone
ALTER TABLE servers ADD COLUMN soundboard_global_mute INTEGER NOT NULL DEFAULT 0;
