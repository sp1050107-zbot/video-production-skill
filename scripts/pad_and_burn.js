/* Pad gpt-image slides into 1920x1080 (top 940px content + bottom 140px white subtitle
   band), and burn subtitles into video_sub.mp4.

   Usage:
     node pad_and_burn.js pad  [project_dir]  # slides_raw/slide_NN.png -> slides/slide_NN.png
     node pad_and_burn.js burn [project_dir]  # video.mp4 + subtitles_aligned.srt -> video_sub.mp4

   Why pad: gpt-image slides are full-bleed 3:2 with text often near the bottom —
   burning subtitles straight onto them covers the slide's own text. The white band
   keeps subtitles fully separated from content.
   Tune burn style with env vars SUB_FS (font size, default 30) / SUB_MV (margin, 30). */
const fs=require('fs'), path=require('path'), {execSync}=require('child_process');
const mode=process.argv[2];
const DIR=path.resolve(process.argv[3]||process.cwd());
const cfgP=path.join(DIR,'config.json');
const cfg=fs.existsSync(cfgP)?JSON.parse(fs.readFileSync(cfgP,'utf8')):{};
const FFMPEG=cfg.ffmpeg||'ffmpeg';
const SRC=path.join(DIR,'slides_raw'), OUT=path.join(DIR,'slides');

if(mode==='pad'){
  if(!fs.existsSync(SRC)){console.error(`ERROR: ${SRC} not found`);process.exit(1);}
  if(!fs.existsSync(OUT)) fs.mkdirSync(OUT,{recursive:true});
  // clear old padded slides
  for(const f of fs.readdirSync(OUT)) if(/^slide_\d+\.png$/i.test(f)) fs.unlinkSync(path.join(OUT,f));
  const files=fs.readdirSync(SRC).filter(f=>/^slide_\d+\.png$/i.test(f)).sort();
  for(const f of files){
    const inp=path.join(SRC,f), outp=path.join(OUT,f);
    execSync(`"${FFMPEG}" -y -i "${inp}" -vf "scale=1410:940:flags=lanczos,pad=1920:1080:255:0:color=white" "${outp}"`,{stdio:'pipe'});
    console.log(`padded ${f}`);
  }
  console.log(`Done: padded ${files.length} slides.`);
}
else if(mode==='burn'){
  const srt=path.join(DIR,'subtitles_aligned.srt');
  const vin=path.join(DIR,'video.mp4');
  const vout=path.join(DIR,'video_sub.mp4');
  // dark text inside the white bottom band; FontSize/MarginV tuned for 1080p 140px band.
  // For full-bleed dark slides (HTML path) use SUB_FS=14-18, SUB_MV=6-12 and a
  // BorderStyle=3 boxed style instead — see SKILL.md Step 6.
  // SUB_STYLE=dark: white text in a translucent black box, for full-bleed dark HTML slides.
  const DARK=process.env.SUB_STYLE==='dark';
  const FS=process.env.SUB_FS||(DARK?'16':'30'), MV=process.env.SUB_MV||(DARK?'10':'30');
  const FONT=process.env.SUB_FONT||(process.platform==='darwin'?'PingFang TC':'Microsoft JhengHei');
  const style=DARK
    ? `FontName=${FONT},FontSize=${FS},PrimaryColour=&H00FFFFFF,BackColour=&H66000000,OutlineColour=&H66000000,BorderStyle=3,Outline=6,Shadow=0,MarginV=${MV},Alignment=2`
    : `FontName=${FONT},FontSize=${FS},PrimaryColour=&H00202020,OutlineColour=&H00FFFFFF,BorderStyle=1,Outline=1,Shadow=0,MarginV=${MV},Alignment=2`;
  // Homebrew's ffmpeg is built without libass, so the subtitles filter may not exist.
  if(!/\bsubtitles\b/.test(execSync(`"${FFMPEG}" -hide_banner -filters`,{encoding:'utf8'}))){
    console.error('ERROR: this ffmpeg has no "subtitles" filter (built without libass) — cannot burn in.');
    console.error('Ship subtitles_aligned.srt as a caption track instead, or embed it as a soft track:');
    console.error('  ffmpeg -i video.mp4 -i subtitles_aligned.srt -c copy -c:s mov_text -metadata:s:s:0 language=chi video_softsub.mp4');
    process.exit(1);
  }
  // ffmpeg subtitles filter needs escaped path on Windows
  const srtEsc=srt.replace(/\\/g,'/').replace(/:/g,'\\:');
  execSync(`"${FFMPEG}" -y -i "${vin}" -vf "subtitles='${srtEsc}':force_style='${style}'" -c:v libx264 -tune stillimage -pix_fmt yuv420p -c:a copy "${vout}"`,{stdio:'pipe'});
  const sz=(fs.statSync(vout).size/1024/1024).toFixed(1);
  console.log(`Burned subtitles -> video_sub.mp4 (${sz} MB)`);
}
else { console.log('usage: node pad_and_burn.js pad|burn [project_dir]'); }
