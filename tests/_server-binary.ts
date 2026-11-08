// Where the isolated-server specs find the release server binary.
//
// They all used to hardcode `server/target/release/e2e-chat`, which is not where
// cargo puts it: the repo's `.cargo/config.toml` redirects the build to a
// repo-relative directory, and on a checkout whose filesystem corrupts Rust
// artifacts (exFAT — see OUTSTANDING_WORK.md N2) the launchers move it to a native
// disk through CARGO_TARGET_DIR. The hardcoded path therefore failed with
// "server binary not found" on any machine that had not built into `target` by
// hand — and on Windows after the same redirect it never existed at all.
//
// Resolution order matches scripts/target-dir.sh: CARGO_TARGET_DIR wins, then the
// config's target-dir, then plain `target` (repo root before server/).
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..');

function binName(): string {
    return process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat';
}

// `build.target-dir = "…"` or `[build]` + `target-dir = "…"` in .cargo/config.toml.
function targetDirFromConfig(): string | null {
    let text: string;
    try {
        text = fs.readFileSync(path.join(REPO, '.cargo', 'config.toml'), 'utf8');
    } catch (_) {
        return null;
    }
    let inBuild = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const section = line.match(/^\[([^\]]+)\]$/);
        if (section) {
            inBuild = section[1].trim() === 'build';
            continue;
        }
        const dotted = line.match(/^build\.target-dir\s*=\s*["']([^"']+)["']$/);
        if (dotted) return dotted[1];
        if (inBuild) {
            const plain = line.match(/^target-dir\s*=\s*["']([^"']+)["']$/);
            if (plain) return plain[1];
        }
    }
    return null;
}

// The release binary, or a thrown Error that says which paths were tried.
export function serverBinaryPath(): string {
    const dirs: string[] = [];
    if (process.env.CARGO_TARGET_DIR) dirs.push(path.resolve(REPO, process.env.CARGO_TARGET_DIR));
    const configured = targetDirFromConfig();
    if (configured) dirs.push(path.resolve(REPO, configured));
    dirs.push(path.join(REPO, 'target'));
    dirs.push(path.join(REPO, 'server', 'target'));

    const tried = dirs.map((d) => path.join(d, 'release', binName()));
    for (const file of tried) {
        if (fs.existsSync(file)) return file;
    }
    throw new Error(
        'server binary not found. Build it first (./start-server.sh, or cargo build --release in server/), ' +
            'or set CARGO_TARGET_DIR. Tried:\n  ' + tried.join('\n  ')
    );
}
