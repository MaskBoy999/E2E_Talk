#!/usr/bin/env python3
"""Final two misses for migration-048 cleanup. Run from project root."""
import sys

def apply_file(path, style, replacements, label):
    with open(path, "rb") as f:
        data = f.read()
    if style == "CRLF":
        data = data.replace(b"\r\n", b"\n")
    src = data.decode("utf-8")
    misses = []
    for old, new, tag, count in replacements:
        n = src.count(old)
        if n < count:
            misses.append(f"{tag}: want>={count} found={n}")
        else:
            src = src.replace(old, new)
    out = src.encode("utf-8")
    if style == "CRLF":
        out = out.replace(b"\n", b"\r\n")
    with open(path, "wb") as f:
        f.write(out)
    if misses:
        print(f"!! {label}: {len(misses)} MISSED")
        for m in misses:
            print(f"   - {m}")
        return False
    print(f"OK  {label}")
    return True

ok = True

# 1) save_dm_message signature (db.rs, CRLF)
sav_dm_sig_old = (
    "    pub fn save_dm_message(\n"
    "        &self,\n"
    "        dm_channel_id: &str,\n"
    "        sender_id: &str,\n"
    "        encrypted_content: &[u8],\n"
    "        nonce: &[u8],\n"
    "        message_nonce: Option<&str>,\n"
    "        encrypted_profile_key: Option<&str>,\n"
    "        profile_key_nonce: Option<&str>,\n"
    "        encrypted_banner_key: Option<&str>,\n"
    "        banner_key_nonce: Option<&str>,\n"
    "        // Streamlined E2E fields\n"
    "        encrypted_profile_snapshot: Option<&[u8]>,\n"
    "        profile_snapshot_nonce: Option<&[u8]>,\n"
    "        encrypted_file_key: Option<&[u8]>,\n"
    "        file_key_nonce: Option<&[u8]>,\n"
    "        encrypted_sender_username: Option<&str>,\n"
    "        sender_username_nonce: Option<&str>,\n"
    "        file_id: Option<&str>,\n"
    "    ) -> Result<DmMessage, String> {\n"
)
sav_dm_sig_new = (
    "    pub fn save_dm_message(\n"
    "        &self,\n"
    "        dm_channel_id: &str,\n"
    "        sender_id: &str,\n"
    "        encrypted_content: &[u8],\n"
    "        nonce: &[u8],\n"
    "        // Streamlined E2E fields\n"
    "        encrypted_profile_snapshot: Option<&[u8]>,\n"
    "        profile_snapshot_nonce: Option<&[u8]>,\n"
    "        encrypted_sender_username: Option<&str>,\n"
    "        sender_username_nonce: Option<&str>,\n"
    "        file_id: Option<&str>,\n"
    "    ) -> Result<DmMessage, String> {\n"
)
ok &= apply_file("server/src/db.rs", "CRLF",
                 [(sav_dm_sig_old, sav_dm_sig_new, "save_dm_message sig", 1)],
                 "db.rs save_dm_message sig")

# 2) list_dm_messages JSON block (handlers.rs, LF) — remove the 4 profile/banner key lines
h_dm_old = (
    "                        \"edited_at\": m.edited_at,\n"
    "                        \"encrypted_profile_key\": m.encrypted_profile_key,\n"
    "                        \"profile_key_nonce\": m.profile_key_nonce,\n"
    "                        \"encrypted_banner_key\": m.encrypted_banner_key,\n"
    "                        \"banner_key_nonce\": m.banner_key_nonce,\n"
    "                        \"key_version\": m.key_version,\n"
)
h_dm_new = (
    "                        \"edited_at\": m.edited_at,\n"
    "                        \"key_version\": m.key_version,\n"
)
ok &= apply_file("server/src/handlers.rs", "LF",
                 [(h_dm_old, h_dm_new, "dm messages json b-keys", 1)],
                 "handlers.rs dm json")

print()
print("ALL DONE" if ok else "MISSED")
sys.exit(0 if ok else 1)
