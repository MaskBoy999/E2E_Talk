-- Phase 17: Username border glow color
-- Users can choose a contrasting glow/border color for their display name
ALTER TABLE users ADD COLUMN username_border_color TEXT;
