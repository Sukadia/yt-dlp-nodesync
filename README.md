# yt-dlp-nodesync

### A Node application to sync your local files to your remote playlists, nest directories based on playlist name, and normalize their audio.

## Features
- Syncs your local files to your remote playlists; deleting songs if they're no longer present.
- Nest a configurable number of local directories when the playlist's name is formatted as `Folder1/Folder2/...`
- Concurrently download a configurable number of playlists at a time
- Automatically normalize audio so tracks have a similar volume range

## How To Use
0. Ensure you have [Node.js](https://nodejs.org) and [NPM](https://www.npmjs.com) installed.
1. Install the [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) and [rsgain](https://github.com/complexlogic/rsgain/releases) binaries. Place in your PATH.
2. Clone the repository and run `npm install`.
3. In each line of `playlistlinks.txt`, add your playlist links.
4. Optionally configure the paths and functionality in `config.toml`.
5. Run `node .` or the included `syncplaylists.bat` anytime you need to sync your playlists!