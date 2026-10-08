/* Generate aligned SRT: Whisper word timestamps for timing, ORIGINAL narration text
   for display (ASR output mishears — never use it as subtitle text).
   Offsets come from temp/segments.json (written by assemble.js) or, for older projects,
   ACTUAL clip durations (ffprobe on temp/clip_XX.mp4), which avoids
   the -shortest drift bug (assuming audioDur+padding drifts +1s per slide).

   Usage: node gen_subtitles.js [project_dir]
   Needs: local mlx-whisper (default) or OPENAI_API_KEY with asr.provider="openai"
   (see asr.js), temp/clip_XX.mp4 from
   assemble.js, audio/slide_XX.mp3, narration.json.
   Whisper word timings are cached in temp/words_NN.json (re-runs are free). */
const fs=require('fs'),path=require('path'),{execSync}=require('child_process'),asr=require('./asr');
const DIR=path.resolve(process.argv[2]||process.cwd());
try{const envp=path.join(DIR,'.env');for(const line of fs.readFileSync(envp,'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^["']|["']$/g,'');}}catch(e){}
const cfgP=path.join(DIR,'config.json');
const cfg=fs.existsSync(cfgP)?JSON.parse(fs.readFileSync(cfgP,'utf8')):{};
const FFPROBE=cfg.ffprobe||'ffprobe';
if((cfg.asr?.provider||'local')==='openai'&&!process.env.OPENAI_API_KEY){console.error('ERROR: asr.provider is "openai" but OPENAI_API_KEY not set');process.exit(1);}
const narration=JSON.parse(fs.readFileSync(path.join(DIR,'narration.json'),'utf8'));
const N=narration.length;

// Slide durations: temp/segments.json from assemble.js (exact frame-aligned lengths) if present,
// else measure the legacy per-slide temp/clip_XX.mp4 files.
const segP=path.join(DIR,'temp','segments.json');
let SEG=fs.existsSync(segP)?JSON.parse(fs.readFileSync(segP,'utf8')).segments:null;
if(SEG&&SEG.length!==N){console.log(`temp/segments.json has ${SEG.length} slides, narration has ${N} — re-run assemble.js; falling back to clip files`);SEG=null;}
function clipDur(i){if(SEG)return SEG[i].duration;const p=path.join(DIR,'temp',`clip_${String(i+1).padStart(2,'0')}.mp4`);return parseFloat(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${p}"`,{encoding:'utf8'}).trim());}

function whisperWords(mp3){return asr.transcribe(mp3,cfg);}

// split into tokens, marking strong (sentence-ending) boundaries; strip punctuation for display
function splitTokens(text){
  const toks=[]; let cur='';
  for(const ch of text){
    if('。！？'.includes(ch)){ if(cur.trim())toks.push({t:cur.trim(),strong:true}); cur=''; }
    else if('，；、：—–…\n,;:'.includes(ch)){ if(cur.trim())toks.push({t:cur.trim(),strong:false}); cur=''; }
    else if('「」『』（）()《》'.includes(ch)){ /* drop quotes/brackets */ }
    else cur+=ch;
  }
  if(cur.trim())toks.push({t:cur.trim(),strong:false});
  return toks.filter(x=>x.t);
}
// display width: CJK = 1, Latin/space = 0.5 (max 16 full-width per line to avoid wrapping)
function dw(s){let w=0;for(const c of s)w+= c.charCodeAt(0)<=0xff?0.5:1; return w;}
function capSplit(s,maxw){ // split s into EVEN pieces of width<=maxw, never inside a Latin run
  // (greedy fill-to-max left 1-char orphans like 「式」 that then overlapped the next cue)
  const segs=[];
  for(let i=0;i<s.length;i++){
    let seg=s[i];
    if(/[A-Za-z0-9]/.test(seg)){ while(i+1<s.length && /[A-Za-z0-9]/.test(s[i+1])) seg+=s[++i]; }
    segs.push(seg);
  }
  const total=segs.reduce((a,x)=>a+dw(x),0);
  const k=Math.ceil(total/maxw);
  if(k<=1) return [s.trim()];
  const target=total/k, parts=[]; let cur='', curw=0;
  for(const seg of segs){
    const w=dw(seg);
    if(cur.trim() && parts.length<k-1 && (curw+w>maxw || curw+w/2>target)){ parts.push(cur.trim()); cur=''; curw=0; }
    cur+=seg; curw+=w;
  }
  if(cur.trim()) parts.push(cur.trim());
  return parts;
}
function chunks(text){
  const toks=splitTokens(text);
  const out=[];
  for(const tk of toks){
    const prev=out[out.length-1];
    if(prev && !prev.strong && (tk.t.length<6 || prev.t.length<8) && (dw(prev.t)+0.5+dw(tk.t))<=16){
      prev.t+=' '+tk.t; prev.strong=tk.strong; // keep the dropped comma as a space
    } else out.push({t:tk.t,strong:tk.strong});
  }
  const capped=[];
  for(const o of out){ for(const p of capSplit(o.t,16)) capped.push(p); }
  return capped;
}

function fmt(t){let ms=Math.round((t-Math.floor(t))*1000);let sec=Math.floor(t);if(ms>=1000){ms-=1000;sec+=1;}const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;}

(async()=>{
  let offset=0; const cues=[];
  for(let i=0;i<N;i++){
    const cd=clipDur(i);
    const mp3=path.join(DIR,'audio',`slide_${String(i+1).padStart(2,'0')}.mp3`);
    const cacheP=path.join(DIR,'temp',`words_${String(i+1).padStart(2,'0')}.json`);
    let words=[];
    if(fs.existsSync(cacheP)){ words=JSON.parse(fs.readFileSync(cacheP,'utf8')); }
    else { try{const w=await whisperWords(mp3);words=w.words||[];fs.writeFileSync(cacheP,JSON.stringify(words));}catch(e){console.log(`slide ${i+1} whisper err: ${e.message} — falling back to proportional timing`);} }
    const speechStart = words.length? Math.max(0, words[0].start-0.05):0;
    const speechEnd = words.length? Math.min(cd, words[words.length-1].end):cd;
    const span = Math.max(0.5, speechEnd-speechStart);
    const ch = chunks(narration[i]);
    // Map narration char position -> TRANSCRIPT char position -> real timestamp.
    // Narration and ASR transcript are ~1:1 in NON-SPACE character count (homophone
    // errors substitute 1:1), so this stays anchored even where seconds-per-char
    // varies wildly (e.g. Latin names: "Claude Code" is 11 chars but ~2 syllables —
    // naive time-proportional mapping drifts seconds there). Chars inside a Whisper
    // word are interpolated linearly across the word's [start,end].
    const strip2=(s)=>s.replace(/\s+/g,'');
    const totalChars = ch.reduce((a,c)=>a+strip2(c).length,0)||1;
    const flat=[];
    for(const w of words){
      const t=strip2(w.word||''); const n2=t.length||1;
      for(let j=0;j<t.length;j++) flat.push(w.start + (w.end-w.start)*(j/n2));
    }
    const timeAtChar=(k)=>{
      if(!flat.length) return speechStart + (k/totalChars)*span;
      const idx2=Math.min(flat.length-1, Math.max(0, Math.round(k*flat.length/totalChars)));
      return Math.min(Math.max(flat[idx2], speechStart), speechEnd);
    };
    let cum=0;
    for(let k=0;k<ch.length;k++){
      const c=ch[k];
      const a=cum, b=cum+strip2(c).length; cum+=strip2(c).length;
      let st=offset+ timeAtChar(a);
      let en=offset+ (k===ch.length-1? speechEnd : timeAtChar(b));
      if(en-st<0.6) en=st+0.6;
      cues.push({st,en,c});
    }
    offset+=cd;
    console.log(`slide ${String(i+1).padStart(2,'0')}: clip=${cd.toFixed(2)}s words=${words.length} chunks=${ch.length}`);
  }
  // never let a cue run into the next one (min-duration padding could overlap)
  for(let k=0;k<cues.length-1;k++) if(cues[k].en>cues[k+1].st) cues[k].en=cues[k+1].st;
  const srt=cues.map((q,k)=>`${k+1}\n${fmt(q.st)} --> ${fmt(q.en)}\n${q.c}\n\n`).join('');
  fs.writeFileSync(path.join(DIR,'subtitles_aligned.srt'), '﻿'+srt, 'utf8');
  console.log(`\nSRT written. total video offset=${offset.toFixed(2)}s`);
})();
