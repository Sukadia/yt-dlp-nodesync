// Dependencies
import Fs from "fs"
import Path from "path"
import Toml from "toml"
import pLimit from "p-limit"
import Process from "process"
import Progress from "cli-progress"
import { exec, spawn } from "child_process"
import { parse } from "id3-parser"
import { fileURLToPath } from "url"

// In case this is called from a different directory, overwrite working directory
const __filename = fileURLToPath(import.meta.url)
Process.chdir(Path.dirname(__filename))

// Config Constants
const Config = Toml.parse(Fs.readFileSync("config.toml"))

const musicdirectory = Config.Files.music_directory
const playlistlinksfile = Config.Files.playlistlinks_file
const maxconcurrent = Config.Functionality.concurrent_downloads
const maxdirectories = Config.Functionality.max_nested_directories
const normalizeaudio = Config.Functionality.normalize_audio
const outputformat = Config["yt-dlp"].output_format
const fileformat = Config["yt-dlp"].file_format
const otherargs = Config["yt-dlp"].other_args

// Generated Constants
const logdirectory = `${musicdirectory}/_Logs`
const promiselimit = pLimit(maxconcurrent)

let parsemetadata_arg = "%(playlist)s:(?P<directory1>[^/]+)"
for (let i=2; i<maxdirectories+1; i++){
    parsemetadata_arg += `(?:/(?P<directory${i}>[^/]+))?`
}

let output_arg = `${musicdirectory}/%(directory1)s/`
for (let i=2; i<maxdirectories+1; i++){
    output_arg += `%(directory${i}|)s/`
}
output_arg += outputformat

function createDirectory(path){
    if (!Fs.existsSync(path)){
        Fs.mkdirSync(path, {recursive: true})
    }
}

async function start(){

    const multibar = new Progress.MultiBar({
        format: `{bar} | {playlist} | {status} | {value}/{total}`,
        emptyOnZero: true,
    }, Progress.Presets.shades_classic)

    async function syncPlaylist(link){
        return new Promise((resolve,reject) => {
            let playlistbar = multibar.create(0, 0, { playlist: link.slice(link.lastIndexOf("=")+1), status: "Fetching" })

            exec(`yt-dlp --flat-playlist -J ${link}`, async (error, stdout, stderr) => {
                if (error) {
                    reject(error.message)
                    return
                }
                if (stderr) {
                    reject(stderr)
                    return
                }
                // Parse playlist info
                let playlistdata = JSON.parse(stdout)
                const playlisttitle = playlistdata.title
                totalvideos += playlistdata.playlist_count

                // Update progress bar with fetched info
                playlistbar.setTotal(playlistdata.playlist_count)
                playlistbar.update({ playlist: playlisttitle, status: "Checking" })

                // Create log directory if needed
                let newdirectory = playlisttitle.split("/").slice(0,-1).join("/")
                createDirectory(`${logdirectory}/${newdirectory}`)

                // Check if a download-archived video is not in the playlist
                let currentvideosfile
                try{
                    currentvideosfile = Fs.readFileSync(`${logdirectory}/${playlisttitle}-archive.txt`, "utf-8")
                }catch{}
                if (currentvideosfile){
                    let currentvideos = currentvideosfile
                        .split(/\r?\n/)
                        .filter(n => n.trim() != "")

                    for (let idcombo of currentvideos){
                        let pos = playlistdata.entries.findIndex((videodata) => {
                            return idcombo == `${videodata.ie_key.toLowerCase()} ${videodata.id}`
                        })

                        // Video was removed, remove from download-archive and directory
                        if (pos == -1){
                            const videoid = idcombo.split(" ")[1]

                            // Remove from download-archive
                            currentvideosfile = currentvideosfile.replace(idcombo,"").split(/\r?\n/).filter(n => n.trim() != "").join("\n")
                            Fs.writeFileSync(`${logdirectory}/${playlisttitle}-archive.txt`,currentvideosfile)

                            // Find video file via metadata and remove
                            Fs.readdir(`${musicdirectory}/${playlisttitle}`, (e, files) => {
                                if (e){
                                    // File likely doesn't exist, that's fine
                                    return
                                }

                                files.forEach(async (file) => {
                                    const filePath = Path.join(`${musicdirectory}/${playlisttitle}`,file)
                                    if (Path.extname(file) != ".mp3") return

                                    try{
                                        const buffer = await Fs.promises.readFile(filePath)
                                        const tags = parse(buffer)

                                        if (tags && tags.comments && tags.comments[0].value == videoid) {
                                            await Fs.promises.unlink(filePath)
                                        }
                                    }catch (e){
                                        reject(e)
                                        return
                                    }
                                })
                            })
                        }
                    }
                }
        
                const ytdlp_args = [
                    fileformat,
                    `--download-archive "${logdirectory}/${playlisttitle}-archive.txt"`,
                    `--parse-metadata "${parsemetadata_arg}"`,
                    `--output "${output_arg}"`,
                    "--embed-metadata",
                    `--parse-metadata "%(id)s:%(meta_comment)s"`,
                    ...otherargs,
                    link
                ]

                let downloadprocess = spawn(`yt-dlp ${ytdlp_args.join(" ")}`, [], { shell: true, stdio: "pipe" })

                // Parse yt-dlp output into progress bar updates; data is buffered so expect multiple occurences
                downloadprocess.stdout.on("data", (data) => {
                    data = data.toString()
                    let numarchived = (data.match(/has already been recorded in the archive/g) || []).length
                    if (numarchived > 0){
                        playlistbar.update({status: "Checking"})
                        playlistbar.increment(numarchived)
                    }
                    let numdownloaded = (data.match(/100%/g) || []).length
                    if (numdownloaded > 0){
                        playlistbar.increment(numdownloaded)
                    }
                    if (data.indexOf("Downloading item") != -1){
                        playlistbar.update({status: "Downloading"})
                    }
                })

                // yt-dlp finished, close promise
                downloadprocess.on("close", (code) => {
                    multibar.remove(playlistbar)
                    mainbar.increment()
                    if (code == 0){
                        resolve()
                        return
                    }else{
                        reject()
                        return
                    }
                })

                downloadprocess.on("error", (error) => {
                    reject(error)
                    return
                })
            })
        })
    }

    const playlistlinks = Fs.readFileSync(`${playlistlinksfile}`,"utf-8")
        .split(/\r?\n/)
        .filter(n => n.trim() != "")
    
    console.log("")

    let mainbar = multibar.create(playlistlinks.length,0,{},{
        format: `{bar} | Synced {value}/{total} playlists`
    })

    let totalvideos = 0
    let playlistpromises = []
    for (let link of playlistlinks){
        playlistpromises.push(promiselimit(() => syncPlaylist(link)))
    }
    let promisearray = await Promise.allSettled(playlistpromises)

    multibar.stop()

    let allsuccess = true
    for (let i=0; i<promisearray.length; i++){
        if (promisearray[i].status == "rejected"){
            allsuccess = false
            console.log(`\n${playlistlinks[i]} failed to sync.`)
            console.log(`Error Message:\n${promisearray[i].reason}`)
        }
    }
    if (allsuccess){
        console.log(`\nSuccessfully synced ${playlistlinks.length} playlists!`)
    }

    if (normalizeaudio){
        const normalizebar = new Progress.SingleBar({
            format: `{bar} | Normalized {value}/{total} audio files`
        }, Progress.Presets.shades_classic)

        normalizebar.start(totalvideos,0)

        await new Promise((resolve,reject) => {
            let normalizeprocess = spawn(`rsgain easy -S -p "./no_album.ini" "${musicdirectory}"`, [], { shell: true, stdio: "pipe" })

            normalizeprocess.stdout.on("data", (data) => {
                data = data.toString()
                let numnormalized = (data.match(/Track/g) || []).length
                if (numnormalized > 0){
                    normalizebar.increment(numnormalized)
                }

                let numskipped = data.match(/Skipped ([\s\S]*?) files/g)
                if (numskipped) normalizebar.increment(Number(numskipped.toString().split(" ")[1]))
            })

            normalizeprocess.stdout.on("close", (code) => {
                normalizebar.stop()
                if (code == 0){
                    resolve()
                }else{
                    reject()
                }
            })
        })
    }

    console.log("\nAll playlists are up-to-date!\n")
}

start()