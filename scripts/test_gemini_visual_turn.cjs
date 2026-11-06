/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
// Optional synthetic live probe: gcloud ADC, ws, Playwright and esbuild required.
const {chromium}=require('playwright');
const esbuild=require('esbuild');
const {WebSocketServer,WebSocket}=require('ws');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const http=require('node:http'),fs=require('node:fs');
const root=require('node:path').resolve(__dirname,'..'),out=require('node:path').resolve(process.argv[2]);
if(fs.existsSync(out))throw Error('Use a new evidence directory');fs.mkdirSync(out,{recursive:true});
const token=execFileSync('gcloud',['auth','application-default','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const project=execFileSync('gcloud',['config','get-value','project'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const location=process.env.GOOGLE_CLOUD_LOCATION||'us-central1',model=process.env.GEMINI_LIVE_MODEL||'gemini-live-2.5-flash-native-audio';
const expected=process.env.PROBE_COLOR||'green',colors={green:'#22c55e',blue:'#3b82f6',yellow:'#eab308'};
if(!colors[expected])throw Error('Choose green, blue, or yellow');
const typedVideo=false;
const candidateOnly=true;
const delayArg=process.argv.find(x=>x.startsWith('--delay='));
const delayMs=0;
const labelArg=process.argv.find(x=>x.startsWith('--label='));
const label=labelArg?labelArg.slice(8):'';
const target=`wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
function build(dir){return esbuild.buildSync({stdin:{contents:"export {XRGeminiLiveController} from './xr-live/src/plugins/gemini-live';",resolveDir:dir},bundle:true,format:'iife',globalName:'Live',write:false,minify:true,target:'es2020'}).outputFiles[0].text;}
const bundles={candidate:build(root)},status={};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/status'){const s=status[u.searchParams.get('key')]||{};res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({setup:s.setup===true,frames:s.frames?.length||0,complete:s.complete===true,error:s.error||null}));return;}res.writeHead(200,{'content-type':'text/html'});res.end('<canvas width="128" height="128"></canvas>');});
const wss=new WebSocketServer({server});
wss.on('connection',(client,req)=>{
 const key=req.url.slice(1),state=status[key]={setup:false,frames:[],complete:false,error:null,outputs:0};
 const remote=new WebSocket(target,{headers:{Authorization:'Bearer '+token}}),queue=[];
 const send=data=>{if(remote.readyState===WebSocket.OPEN)remote.send(data);else if(remote.readyState===WebSocket.CONNECTING)queue.push(data);};
 remote.on('open',()=>{for(const data of queue.splice(0))remote.send(data);});
 client.on('message',data=>{let m;try{m=JSON.parse(data.toString());}catch{return;}
  if(m.setup){m.setup.model=`projects/${project}/locations/${location}/publishers/google/models/${model}`;m.setup.generationConfig={responseModalities:['AUDIO']};m.setup.outputAudioTranscription={};}
  const chunk=m.realtimeInput?.mediaChunks?.[0];if(chunk?.data)state.frames.push(createHash('sha256').update(chunk.data,'base64').digest('hex'));
  if(typedVideo && chunk?.data)m.realtimeInput={video:chunk};
  send(JSON.stringify(m));
 });
 remote.on('message',data=>{let m;try{m=JSON.parse(data.toString());}catch{return;}if(m.setupComplete||m.setup_complete)state.setup=true;
  const content=m.serverContent||m.server_content;if(content){if(content.outputTranscription||content.output_transcription)state.outputs++;if(content.turnComplete||content.turn_complete)state.complete=true;}
  if(m.error)state.error={code:m.error.code,status:m.error.status};if(client.readyState===WebSocket.OPEN)client.send(data);
 });
 remote.on('error',()=>{state.error={kind:'transport_error'};});remote.on('close',(code)=>{if(code!==1000&&!state.complete)state.error=state.error||{kind:'remote_close',code};if(client.readyState===WebSocket.OPEN)client.close();});
 client.on('close',()=>{if(remote.readyState===WebSocket.OPEN||remote.readyState===WebSocket.CONNECTING)remote.close();});client.on('error',()=>{});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--use-angle=metal','--enable-gpu']});
 const results=[];
 try {for(const variant of (candidateOnly?['candidate']:['base','candidate'])){
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}/`);await page.addScriptTag({content:bundles[variant]});
  const result=await page.evaluate(async({port,variant,delayMs,color})=>{
   const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
   const grab=async color=>{ctx.fillStyle=color;ctx.fillRect(0,0,128,128);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));return await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result.split(',')[1]);reader.readAsDataURL(blob);});};
   const oldImage=await grab('#ef4444'),newImage=await grab(color),digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(b),c=>c.charCodeAt(0))))).map(v=>v.toString(16).padStart(2,'0')).join('');
   let release,calls=0;const delayed=new Promise(r=>release=r),events=[];
   const host={dispatchEvent(e){if(e.type==='xr-transcription')events.push(e.detail);return true;},captureViewFrame(){calls++;return calls===1?delayed:Promise.resolve({base64:newImage,mimeType:'image/png'});}};
   const ctrl=new Live.XRGeminiLiveController(host);
   async function wait(key,condition,timeout=15000){const end=performance.now()+timeout;while(performance.now()<end){const s=await(await fetch('/status?key='+encodeURIComponent(key),{cache:'no-store'})).json();if(s.error)throw Error('remote '+JSON.stringify(s.error));if(s[condition])return s;await new Promise(r=>setTimeout(r,80));}throw Error('timeout waiting for '+key+' '+condition);}
   ctrl.connect({url:`ws://127.0.0.1:${port}/${variant}-old`,setup:{},streamFrames:false,playAudio:false});await wait(variant+'-old','setup');
   const old=ctrl.sendFrame();ctrl.connect({url:`ws://127.0.0.1:${port}/${variant}-new`,setup:{},streamFrames:false,playAudio:false});await wait(variant+'-new','setup');
   const fresh=ctrl.sendFrame();release({base64:oldImage,mimeType:'image/png'});const [oldSent,newSent]=await Promise.all([old,fresh]);await wait(variant+'-new','frames');
   ctrl.sendText('What is the single dominant color of the attached image? Answer in one word.',{captureFrame:true});await wait(variant+'-new','complete',30000);await new Promise(r=>setTimeout(r,100));
   const transcript=events.filter(x=>x.speaker==='model').map(x=>({text:x.text,isFinal:x.isFinal}));ctrl.disconnect();
   return {oldSent,newSent,calls,oldDigest:await digest(oldImage),newDigest:await digest(newImage),transcript};
  },{port,variant,delayMs,color:colors[expected]});
  const s=status[variant+'-new'];const frameColors=s.frames.map(d=>d===result.oldDigest?'old red':d===result.newDigest?'current image':'unknown');
  const row={variant,realSessionSetup:s.setup,oldCaptureReportedSent:result.oldSent,newCaptureReportedSent:result.newSent,framesForwardedToGemini:frameColors,modelCompleted:s.complete,transcriptEvents:result.transcript,outputTranscriptionPackets:s.outputs};
  results.push(row);console.log(JSON.stringify(row));await page.close();
 }
 fs.writeFileSync(out+(label?'/gemini-live-'+label+'.json':typedVideo?'/gemini-live-reconnect-typed-video.json':'/gemini-live-reconnect.json'),JSON.stringify({executedAt:new Date().toISOString(),expected,sourceDirty:execFileSync('git',['status','--porcelain','--','xr-live/src','scripts'],{cwd:root,encoding:'utf8'}).trim(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),bundleSha256:createHash('sha256').update(bundles.candidate).digest('hex'),method:'Headless Chrome using the actual XRGeminiLiveController through a temporary localhost authenticated proxy to Vertex AI Gemini Live; synthetic contrasting-color canvas captures, with the first deliberately delayed across a real reconnect.',model,location,typedVideo,delayMs,results},null,2));
 if(!results.every(x=>x.modelCompleted && x.framesForwardedToGemini.every(x=>x==='current image') && x.transcriptEvents.some(e=>e.isFinal && new RegExp(expected,'i').test(e.text))))process.exitCode=1;
 } finally {await browser.close();wss.clients.forEach(ws=>ws.terminate());wss.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e.message);wss.clients.forEach(ws=>ws.terminate());wss.close();server.closeAllConnections();server.close();process.exitCode=1});
