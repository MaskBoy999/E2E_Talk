-- Migration 015: Username color and profile picture file key support
ALTER TABLE users ADD COLUMN username_color TEXT DEFAULT '#4fc3f7';
