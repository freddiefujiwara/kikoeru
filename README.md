# otod

A streaming relay for YouTube audio. It exists because of a quirk of
googlevideo stream URLs (the ones `yt-dlp -g -f bestaudio[ext=m4a]`
returns):

- A plain sequential GET is throttled to roughly the playback bitrate
  (~31 KB/s measured), so long videos take tens of seconds to start.
- Ranged requests are answered at full speed (~10 MB/s measured), but a
  single large range is throttled again.
- Fetching in small ranged chunks (<= 4 MiB) stays fast end to end
  (a 16.6 MB file in ~1.7 s measured).

`otod` sits between the client and googlevideo: it fetches the
upstream stream in <= 4 MiB ranged chunks and forwards the bytes as they
arrive. **Nothing is written to disk** — it is a relay, not a file host.

Built for the [reader](https://github.com/freddiefujiwara/reader) web RSS
reader, whose YouTube "podcast" playback uses these stream URLs.

## Usage

```
GET /<token>/<videoId>
```

The server is published at the root of its own host:
`https://y.ze.gs/<token>/<videoId>`.

- `token` — a shared secret (see below). Wrong token: 404.
- `videoId` — an 11-character YouTube video id. Anything else: 404.

Clients may send a single `Range` header (`bytes=a-b`, `bytes=a-`,
`bytes=-n`); the server answers 206 with the exact byte slice, fetched
from upstream in <= 4 MiB sub-ranges. Without a Range header it answers
200 and streams the whole file the same way. `If-Range` is ignored.

### Stream URL resolution

Extracting stream URLs is **not** this server's job — that belongs to
the shell pipeline (yt-audio / yt-audio-batch, which runs yt-dlp). This
server only reads the pipeline's cache (`~/.yt-audio/cache.json`,
read-only):

- entry present and younger than 5 hours → relay that URL;
- entry missing or stale → **404** (the shell refreshes it on its
  cycle).

If the upstream answers 403 (URL expired server-side), the server
re-reads the batch cache once — the shell may have refreshed it in the
meantime — and retries; if that still fails, the answer is 404.

### Token

The token lives in `~/.config/otod/token` (mode 600). If the file
does not exist, the server generates a random 32-hex-digit token on
first start and saves it there.

## Configuration

All settings have defaults matching the home-server layout; each can be
overridden by an environment variable.

| Variable | Default |
| --- | --- |
| `OTOD_HOST` | `127.0.0.1` |
| `OTOD_PORT` | `8791` |
| `OTOD_TOKEN` | (contents of the token file) |
| `OTOD_TOKEN_FILE` | `~/.config/otod/token` |
| `YT_AUDIO_CACHE` | `~/.yt-audio/cache.json` |

No external dependencies — Node.js standard library only (Node >= 18).

## Run

```sh
npm install -g otod   # once published; see below for tarball installs
otod
```

## Install from a tarball (current method)

npm publishing is not set up yet (it needs an `NPM_TOKEN` for this
repository). Until then, install from a packed tarball:

```sh
npm pack
npm install -g ./otod-0.1.0.tgz
```

With mise's Node 24 on the home server, the global prefix is the Node
installation directory, so the module lands in
`~/.local/share/mise/installs/node/<version>/lib/node_modules/otod`
and the `otod` command in the sibling `bin/`.

## systemd user service

`~/.config/systemd/user/otod.service`:

```ini
[Unit]
Description=otod (YouTube audio streaming relay)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/home/fumikazu/.local/share/mise/installs/node/24.14.1/bin/node /home/fumikazu/.local/share/mise/installs/node/24.14.1/lib/node_modules/otod/bin/otod.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now otod
```

(Adjust the Node version in the paths when Node is upgraded. User
lingering is already enabled on the server, so the service starts at
boot.)

## Reverse proxy

The server only listens on localhost. On the home server, nginx
publishes it as its own virtual host, `https://y.ze.gs/`, proxying the
whole site to `127.0.0.1:8791`; the setup notes live with the
server-side documentation.

## Development

```sh
npm test   # node:test, spins up a fake upstream; no network needed
```
