[![npm version](https://badge.fury.io/js/kikoeru.svg)](https://badge.fury.io/js/kikoeru)

# kikoeru

A small server that relays YouTube audio. It fetches the sound in
small pieces and passes the pieces to the listener right away, so
playback starts fast.

## Why this exists

YouTube gives each video a special web address for its sound. Tools
like `yt-dlp` can find this address. The address works, but it has a
problem:

- If a player asks for the sound in the normal way (from the start,
  in order), YouTube sends the data very slowly — about as fast as
  the sound plays (about 31 KB per second in our tests). A long
  video can take 40 seconds before the first sound comes out.
- If a player asks for a part of the file (a "range request"), YouTube
  sends the data fast (about 10 MB per second in our tests). But if
  the part is too big, YouTube slows down again.
- Asking for small parts, one after another, stays fast to the end.
  In our tests, a 16.6 MB file arrived in about 1.7 seconds this way.

A phone browser cannot be told to fetch in small parts. So kikoeru sits
in the middle: the phone asks kikoeru, and kikoeru asks YouTube in small
parts.

## What kikoeru does

- It listens for requests of one form: `GET /<token>/<videoId>`.
- It looks up the video's sound address in a cache file (see below).
- It asks YouTube for the file in small parts of at most 4 MiB
  (4,194,304 bytes) and sends each part to the listener as soon as
  it arrives.
- It saves nothing. No sound file is ever written to disk. kikoeru is a
  relay, not a file host.

## What kikoeru does not do

Finding the sound address is **not** kikoeru's job. A shell pipeline
(`yt-audio` and `yt-audio-batch`, which run `yt-dlp`) finds the
addresses and writes them to a cache file:

```text
~/.yt-audio/cache.json
```

kikoeru only reads this file. For each video, the file holds the sound
address and the time it was found:

```json
{
  "htzMcSM6Ft0": {
    "url": "https://...googlevideo.com/...",
    "ts": 1763200000
  }
}
```

The rules are simple:

- Entry exists and is less than 5 hours old → kikoeru relays the sound.
- Entry is missing or older than 5 hours → kikoeru answers 404.
  (The shell pipeline will find a fresh address on its next run.)

Sound addresses stop working after some hours. If YouTube answers
403 ("forbidden") while kikoeru is working, kikoeru reads the cache file
one more time — the shell pipeline may have put a fresh address in
it — and tries once more. If the address still does not work, kikoeru
answers 404.

If YouTube fails while the sound is being sent, kikoeru never leaves
the listener waiting. When no sound has been sent yet, kikoeru answers
502 ("bad gateway") at once. When some sound has already been sent,
kikoeru ends the connection at once, so the player can show an error
instead of waiting for ever.

Built for the [reader](https://github.com/freddiefujiwara/reader)
web RSS reader, which plays YouTube videos like podcasts.

## Requirements

- Node.js 18 or later
- No extra packages. kikoeru uses only the Node.js standard library.

## Installation

From npm:

```bash
npm i -g kikoeru
```

Or from a tarball built from this repository:

```bash
npm pack                      # makes kikoeru-0.1.2.tgz
npm i -g ./kikoeru-0.1.2.tgz
```

With mise's Node on our home server, the global install goes to the
Node directory itself, so the module lands in
`~/.local/share/mise/installs/node/<version>/lib/node_modules/kikoeru`
and the `kikoeru` command in the `bin/` folder next to it.

## Usage

```bash
kikoeru
```

This starts the server on `127.0.0.1:8791`. It only listens on the
local machine. To let others reach it, put a reverse proxy in front
of it (see "Reverse proxy" below).

### The request form

```text
GET /<token>/<videoId>
```

- `token` — a shared secret word. It is part of the address, like a
  password in the link. A wrong token gets a 404 answer.
- `videoId` — the 11-character YouTube video id (letters, numbers,
  `-` and `_`). Anything else gets a 404 answer.

Every other address also gets a 404 answer: the top page `/`,
addresses with extra parts, and so on. Only GET and HEAD requests
are answered.

### Ranges

Players may ask for one part of the file with a `Range` header:

```text
Range: bytes=1000000-1999999
Range: bytes=1000000-
Range: bytes=-1000
```

kikoeru answers `206` with exactly those bytes and a `Content-Range`
header. The parts are still fetched from YouTube in pieces of at
most 4 MiB. If the part cannot be given (for example, it starts
after the end of the file), kikoeru answers `416`. A `Range` header
that kikoeru cannot read is ignored, and the whole file is sent.
`If-Range` is ignored.

## The token

The token lives in a file:

```text
~/.config/kikoeru/token
```

- If the file exists, kikoeru reads the token from it.
- If the file does not exist, kikoeru makes a random token (32 hex
  digits) on the first start, saves it to the file with permission
  `600` (only the owner can read it), and uses it from then on.
- You can also set the token with the `KIKOERU_TOKEN` environment
  variable (see below). Then the file is not used.

Anyone who knows the token and a video id can listen through your
server, so keep the token secret.

## Configuration

Every setting has a default. Each one can be changed with an
environment variable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIKOERU_HOST` | `127.0.0.1` | Address to listen on |
| `KIKOERU_PORT` | `8791` | Port to listen on |
| `KIKOERU_TOKEN` | (contents of the token file) | The shared secret |
| `KIKOERU_TOKEN_FILE` | `~/.config/kikoeru/token` | Where the token is kept |
| `YT_AUDIO_CACHE` | `~/.yt-audio/cache.json` | The shell pipeline's cache file |

## Example

Start the server, read the token, and ask for a video:

```bash
kikoeru &
TOKEN=$(cat ~/.config/kikoeru/token)
curl -o sound.m4a "http://127.0.0.1:8791/$TOKEN/htzMcSM6Ft0"
```

Ask for only the first 100 bytes:

```bash
curl -H 'Range: bytes=0-99' "http://127.0.0.1:8791/$TOKEN/htzMcSM6Ft0"
# -> 206, Content-Range: bytes 0-99/<full size>, 100 bytes of sound
```

A video that is not in the cache, or a wrong token:

```bash
curl -i "http://127.0.0.1:8791/wrong-token/htzMcSM6Ft0"
# -> 404 Not Found
```

## Run it as a service (systemd)

On our home server, kikoeru runs as a systemd user service. The unit
file is `~/.config/systemd/user/kikoeru.service`:

```ini
[Unit]
Description=kikoeru (YouTube audio streaming relay)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/home/fumikazu/.local/share/mise/installs/node/24.14.1/bin/node /home/fumikazu/.local/share/mise/installs/node/24.14.1/lib/node_modules/kikoeru/bin/kikoeru.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Change the Node version in the paths when Node is upgraded. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now kikoeru
```

If user lingering is on (`loginctl enable-linger`), the service
starts at boot and keeps running after logout.

## Reverse proxy

kikoeru only listens on the local machine, so we publish it with nginx
on its own host name. In this example the host is `y.ze.gs` and the
whole site is passed to kikoeru:

```nginx
server {
    listen 443 ssl;
    server_name y.ze.gs;

    ssl_certificate     /etc/letsencrypt/live/ze.gs/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ze.gs/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8791;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Range $http_range;
        proxy_set_header If-Range $http_if_range;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
}
```

Then a listener uses `https://y.ze.gs/<token>/<videoId>`. Notes:

- `proxy_buffering off` matters: the sound must flow to the listener
  as it arrives, not after nginx has collected a big part of it.
- The token is the only lock. There is no login page.

## Development

Run the tests:

```bash
npm test
```

The tests use the Node.js test runner. They start a fake YouTube
server on the local machine, so no network is needed. They cover:

- the request form: right and wrong tokens, video id rules, wrong
  paths, request methods;
- the cache rules: fresh, old, missing and broken cache files;
- ranges: all three forms, ends past the file size, parts that
  cannot be given (416);
- the small-parts fetching: every request to the fake YouTube is
  recorded and checked to be at most 4 MiB, in order, and complete;
- errors from YouTube: 403 and the one retry with a fresh cache,
  500 answers, and refused connections;
- the token file: how it is made, its permission, and reuse after
  a restart;
- the environment variables for all settings.

## Contributing

Bug reports and pull requests are welcome on GitHub at https://github.com/freddiefujiwara/kikoeru
