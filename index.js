// Dependenciesdirectory
import pLimit from "p-limit"
import Fs from "fs"
import Path from "path"
import toml from "toml"
import { exec } from "child_process"
import { parse } from "id3-parser"

// Config Constants
const Config = toml.parse(Fs.readFileSync("config.toml"))

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

    async function syncPlaylist(link){
        return new Promise((resolve,reject) => {
            console.log(`Fetching playlist ${link}`)
            exec(`yt-dlp --flat-playlist -J ${link}`, async (error, stdout, stderr) => {
                if (error) {
                    console.error(`error: ${error.message}`)
                    return
                }
                if (stderr) {
                    console.error(`stderr: ${stderr}`)
                    return
                }
                let playlistdata = JSON.parse(stdout)
                const playlisttitle = playlistdata.title
                console.log(`Fetched ${playlisttitle}`)

                // Create log directory if needed
                let newdirectory = playlisttitle.split("/").slice(0,-1).join("/")
                createDirectory(`${logdirectory}/${newdirectory}`)

                // Check if a download-archived video is not in the playlist
                let currentvideosfile
                try{
                    currentvideosfile = Fs.readFileSync(`${logdirectory.slice(2)}/${playlisttitle}-archive.txt`,"utf-8")
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
                            console.log(`Video ${videoid} was removed`)

                            // Remove from download-archive
                            currentvideosfile = currentvideosfile.replace(idcombo,"").split(/\r?\n/).filter(n => n.trim() != "").join("\n")
                            Fs.writeFileSync(`${logdirectory.slice(2)}/${playlisttitle}-archive.txt`,currentvideosfile)

                            // Find video file via metadata and remove
                            Fs.readdir(`${musicdirectory}/${playlisttitle}`, (e, files) => {
                                if (e){
                                    console.error(e)
                                    return
                                }

                                files.forEach(async (file) => {
                                    const filePath = Path.join(`${musicdirectory}/${playlisttitle}`,file)
                                    if (Path.extname(file) != ".mp3") return

                                    console.log(file)
                                    try{
                                        const buffer = await Fs.promises.readFile(filePath)
                                        const tags = parse(buffer)

                                        if (tags && tags.comments && tags.comments[0].value == videoid) {
                                            await Fs.promises.unlink(filePath)
                                            console.log(`Found and deleted ${file}`)
                                        }
                                    }catch (e){
                                        console.error(e)
                                    }
                                })
                            })
                        }
                    }
                }
        
                const ytdlp_args = [
                    fileformat,
                    `--download-archive "${logdirectory.slice(2)}/${playlisttitle}-archive.txt"`,
                    `--parse-metadata "${parsemetadata_arg}"`,
                    `--output "${output_arg}"`,
                    "--embed-metadata",
                    `--parse-metadata "%(id)s:%(meta_comment)s"`,
                    ...otherargs,
                    link
                ]
        
                let downloadprocess = exec(`yt-dlp ${ytdlp_args.join(" ")}`, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`error: ${error.message}`)
                        return
                    }
                    if (stderr) {
                        console.error(`stderr: ${stderr}`)
                        return
                    }
                    console.log(stdout)
                    resolve()
                })
                downloadprocess.stdout.pipe(process.stdout)
            })
        })
    }

    const playlistlinks = Fs.readFileSync(`${playlistlinksfile}`,"utf-8")
        .split(/\r?\n/)
        .filter(n => n.trim() != "")
    
    let playlistpromises = []
    for (let link of playlistlinks){
        playlistpromises.push(promiselimit(() => syncPlaylist(link)))
    }
    await Promise.allSettled(playlistpromises)

    if (normalizeaudio){
        await new Promise((resolve,reject) => {
            let normalizeprocess = exec(`rsgain easy -S -p "./no_album.ini" "${musicdirectory}"`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`error: ${error.message}`)
                    return
                }
                if (stderr) {
                    console.error(`stderr: ${stderr}`)
                    return
                }
                console.log(stdout)
                resolve()
            })
            normalizeprocess.stdout.pipe(process.stdout)
        })
    }

    console.log("All playlists are up-to-date!")
}

start()